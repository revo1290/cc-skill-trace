import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import chalk from "chalk";
import type { Command } from "commander";
import { getStoreDir, loadConfig, loadState, saveConfig } from "../../core/config.js";
import { ALL_PROVIDER_IDS, getProvider } from "../../core/providers/index.js";
import { checkStore, readEvents, repairStore } from "../../core/store.js";
import type { ProviderId } from "../../core/types.js";
import { VERSION } from "../context.js";
import { confirm, fail, isClaudeCodeRunning, vlog } from "../ui.js";
import { parseProviderOpt } from "../options.js";
import { writeSettingsAtomic } from "../atomic-write.js";
import { CC_HOOK_COMMAND, isCcSkillTraceHook } from "../hooks.js";
import { computeSkillMdStale, normalizeSkillMd, skillMdChanged } from "../skill-md.js";
import type { ReadResult } from "../skill-md.js";

// ─── Settings / skill helpers (shared with other commands) ───────────────────

/** Where a given provider's hook settings file lives, for a given scope (#v3-multi-provider). */
export function settingsPathFor(project: boolean, provider: ProviderId = "claude-code"): string {
  return getProvider(provider).hookInfo(project).settingsPath;
}

/**
 * The hook matcher and command suffix differ by provider: Claude Code has a
 * dedicated `Skill` tool to match on; Codex/Copilot have no such tool, so we
 * match every tool call (`"*"`) and let hook-capture itself decide whether
 * the call touched a known SKILL.md (#v3-multi-provider).
 */
function hookSpecsFor(
  provider: ProviderId
): Array<{ event: "PreToolUse" | "PostToolUse"; command: string; matcher: string }> {
  const matcher = provider === "claude-code" ? "Skill" : "*";
  const suffix = provider === "claude-code" ? "" : ` --provider ${provider}`;
  return [
    { event: "PreToolUse", command: `${CC_HOOK_COMMAND}${suffix}`, matcher },
    { event: "PostToolUse", command: `${CC_HOOK_COMMAND} --post${suffix}`, matcher },
  ];
}

export const installedSkillMdPath = join(homedir(), ".claude", "skills", "skill-trace", "SKILL.md");

/**
 * Path of the SKILL.md bundled inside this package.
 *
 * Primary: `dist/skill/SKILL.md`, copied there by the build step
 * (scripts/copy-skill.mjs, since `tsc` never copies .md assets, #183).
 * Fallback: the source copy shipped verbatim in the package (`files` includes
 * `src/skill/SKILL.md`), so a published build that predates the copy step
 * still resolves instead of failing with "Skill file not found".
 */
export async function bundledSkillMdPath(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const primary = join(here, "..", "..", "skill", "SKILL.md");
  const fallback = join(here, "..", "..", "..", "src", "skill", "SKILL.md");
  for (const candidate of [primary, fallback]) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return primary;
}

async function readSkillMd(path: string): Promise<ReadResult> {
  try {
    return { ok: true, content: await readFile(path, "utf-8") };
  } catch {
    return { ok: false };
  }
}

/** Returns true when the installed SKILL.md differs from the bundled one (line-ending agnostic, #181). */
export async function isSkillMdStale(): Promise<boolean> {
  const [bundled, installed] = await Promise.all([
    readSkillMd(await bundledSkillMdPath()),
    readSkillMd(installedSkillMdPath),
  ]);
  const { stale, bundledMissing } = computeSkillMdStale(bundled, installed);
  if (bundledMissing) {
    // A missing bundled SKILL.md means the package was built incorrectly (#183, #190/#212).
    process.stderr.write(
      chalk.yellow("⚠  Bundled SKILL.md not found — the package may be built incorrectly.\n\n")
    );
  }
  return stale;
}

type Settings = Record<string, unknown>;

interface SettingsReadResult {
  settings: Settings;
  missing: boolean;
  corrupt: boolean;
}

/** Read a settings.json distinguishing "missing" (fine) from "corrupt" (#141). */
export async function readSettingsSafe(path: string): Promise<SettingsReadResult> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { settings: {}, missing: true, corrupt: false };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object")
      return { settings: {}, missing: false, corrupt: true };
    return { settings: parsed as Settings, missing: false, corrupt: false };
  } catch {
    return { settings: {}, missing: false, corrupt: true };
  }
}

function corruptSettingsError(path: string): never {
  return fail(
    `${path} exists but is not valid JSON.\n` +
      `   Refusing to overwrite it — fix the file manually (a backup may exist at ${path}.bak),\n` +
      "   then re-run this command. Tip: cc-skill-trace doctor"
  );
}

interface HookMatcherEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string }>;
  [key: string]: unknown;
}

function hookRegistered(settings: Settings, event: string): boolean {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const entries = (hooks[event] ?? []) as HookMatcherEntry[];
  return entries.some(isCcSkillTraceHook);
}

function addHook(settings: Settings, event: string, command: string, matcher: string): void {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const entries = [...((hooks[event] ?? []) as HookMatcherEntry[])];
  entries.push({ matcher, hooks: [{ type: "command", command }] });
  settings.hooks = { ...hooks, [event]: entries };
}

/**
 * Remove only our hook commands, preserving everything else (#129).
 * An entry that still has other hooks is kept with those hooks intact.
 * Matches on the `command` field precisely (#187) rather than a whole-object
 * substring search, so an unrelated hook that merely mentions "cc-skill-trace"
 * (e.g. in a description) is not deleted.
 */
function removeOurHooks(settings: Settings): number {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  let removed = 0;
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept: HookMatcherEntry[] = [];
    for (const entry of entries as HookMatcherEntry[]) {
      if (!isCcSkillTraceHook(entry)) {
        kept.push(entry);
        continue;
      }
      const filtered = (entry.hooks ?? []).filter(
        (h) => !(typeof h?.command === "string" && h.command.includes(CC_HOOK_COMMAND))
      );
      removed += (entry.hooks?.length ?? 0) - filtered.length;
      if (filtered.length > 0) kept.push({ ...entry, hooks: filtered });
      // entries whose hooks were all ours are dropped
    }
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  return removed;
}

// ─── install ──────────────────────────────────────────────────────────────────

async function runInstall(opts: {
  project?: boolean;
  check?: boolean;
  skillTemplate?: string;
  provider?: ProviderId;
}): Promise<void> {
  const provider = opts.provider ?? "claude-code";
  const specs = hookSpecsFor(provider);
  const settingsPath = settingsPathFor(Boolean(opts.project), provider);
  const { settings, corrupt } = await readSettingsSafe(settingsPath);
  if (corrupt) corruptSettingsError(settingsPath);

  // ── --check: report state, change nothing (#153) ─────────────────────────
  if (opts.check) {
    let ok = true;
    for (const spec of specs) {
      const registered = hookRegistered(settings, spec.event);
      ok &&= registered;
      console.log(
        registered
          ? chalk.green(`✓  ${spec.event} hook registered`)
          : chalk.red(`✗  ${spec.event} hook NOT registered`)
      );
    }
    if (provider === "claude-code") {
      const stale = await isSkillMdStale();
      const installed = await readFile(installedSkillMdPath, "utf-8").then(
        () => true,
        () => false
      );
      if (!installed) {
        console.log(chalk.red("✗  SKILL.md not installed"));
        ok = false;
      } else if (stale) {
        console.log(chalk.yellow("⚠  SKILL.md outdated — run: cc-skill-trace install"));
        ok = false;
      } else console.log(chalk.green("✓  SKILL.md up to date"));
    }
    process.exit(ok ? 0 : 1);
  }

  // ── Warn when Claude Code is running: hooks load at startup (#71) ────────
  if (provider === "claude-code" && isClaudeCodeRunning()) {
    console.log(
      chalk.yellow(
        "⚠  Claude Code appears to be running — restart it after install for hooks to load."
      )
    );
  }

  if (provider !== "claude-code") {
    console.log(
      chalk.yellow(
        `⚠  ${getProvider(provider).displayName} support is best-effort (#v3-multi-provider): the hook payload shape has not been verified against a live run. If events don't show up after using a skill, run "cc-skill-trace doctor" and check CC_DEBUG=1 output.`
      )
    );
    if (provider === "codex") {
      console.log(
        chalk.gray(
          "  Codex also requires [features].codex_hooks = true in ~/.codex/config.toml — cc-skill-trace does not edit that file for you."
        )
      );
    }
  }

  // ── 1. Hook registration (Pre + Post, skip those already present) ───────
  let changed = false;
  for (const spec of specs) {
    if (hookRegistered(settings, spec.event)) {
      console.log(chalk.gray(`  ${spec.event} hook already registered → ${settingsPath}`));
    } else {
      addHook(settings, spec.event, spec.command, spec.matcher);
      changed = true;
      console.log(chalk.green(`✓  ${spec.event} hook installed → ${settingsPath}`));
    }
  }
  if (changed) {
    await writeSettingsAtomic(settingsPath, settings);
    console.log(
      chalk.gray(`  Restart ${getProvider(provider).displayName} for the hooks to take effect.`)
    );
  }

  if (provider !== "claude-code") return; // no SKILL.md/dashboard-skill concept to sync for other providers

  // ── 2. SKILL.md — sync to the bundled (or custom, #162) template ─────────
  const skillDir = join(homedir(), ".claude", "skills", "skill-trace");
  const skillSrc = opts.skillTemplate ? resolve(opts.skillTemplate) : await bundledSkillMdPath();
  try {
    const bundled = await readFile(skillSrc, "utf-8");
    const installed = await readFile(installedSkillMdPath, "utf-8").catch(() => null);
    await mkdir(skillDir, { recursive: true });
    // Write with LF-normalized content so a Windows CRLF checkout of the bundled
    // file doesn't leave the installed copy looking permanently stale (#181).
    await writeFile(installedSkillMdPath, normalizeSkillMd(bundled), "utf-8");
    if (opts.skillTemplate) {
      console.log(chalk.green(`✓  Custom SKILL.md installed → ${skillDir}`));
      console.log(chalk.gray(`  Template: ${skillSrc}`));
    } else if (installed === null) {
      console.log(chalk.green(`✓  Skill installed   → ${skillDir}`));
      console.log(chalk.gray("  Use /skill-trace inside Claude Code to open the dashboard."));
    } else if (skillMdChanged(installed, bundled)) {
      console.log(chalk.green(`✓  SKILL.md updated  → ${skillDir}`));
      console.log(chalk.gray("  Restart Claude Code to apply the updated skill definition."));
    } else {
      console.log(chalk.gray("  SKILL.md already up to date."));
    }
  } catch {
    if (opts.skillTemplate) fail(`Skill template not found: ${skillSrc}`);
    console.log(chalk.yellow(`  Skill file not found at ${skillSrc}`));
    console.log(
      chalk.yellow("  The npm package may be corrupt — try: npm install -g cc-skill-trace --force")
    );
  }
}

// ─── uninstall ────────────────────────────────────────────────────────────────

async function runUninstall(opts: {
  project?: boolean;
  force?: boolean;
  provider?: ProviderId;
}): Promise<void> {
  const provider = opts.provider ?? "claude-code";
  const settingsPath = settingsPathFor(Boolean(opts.project), provider);
  const { settings, missing, corrupt } = await readSettingsSafe(settingsPath);
  if (missing) {
    console.log(chalk.yellow(`⚠  Settings file not found: ${settingsPath}`));
    return;
  }
  if (corrupt) corruptSettingsError(settingsPath);

  if (!(await confirm(`Remove cc-skill-trace hooks and skill from ${settingsPath}?`, opts.force))) {
    console.log(chalk.gray("  Aborted. (Use --force to skip this prompt in scripts.)"));
    return;
  }

  const removed = removeOurHooks(settings);
  if (removed === 0) {
    console.log(chalk.yellow(`⚠  Hook not found in: ${settingsPath}`));
  } else {
    await writeSettingsAtomic(settingsPath, settings);
    console.log(
      chalk.green(`✓  ${removed} hook${removed === 1 ? "" : "s"} removed from: ${settingsPath}`)
    );
  }

  if (provider === "claude-code") {
    // Remove the installed skill file
    const skillDir = join(homedir(), ".claude", "skills", "skill-trace");
    try {
      await rm(skillDir, { recursive: true, force: true });
      console.log(chalk.green(`✓  Skill removed   → ${skillDir}`));
    } catch {
      console.log(chalk.yellow(`⚠  Could not remove skill directory: ${skillDir}`));
    }
  }

  console.log(
    chalk.gray(`  Restart ${getProvider(provider).displayName} for the change to take effect.`)
  );
  console.log(
    chalk.gray(
      `  Your captured events remain in ${getStoreDir()} — remove with: cc-skill-trace clear --force`
    )
  );
}

// ─── status (#98) ─────────────────────────────────────────────────────────────

async function runStatus(): Promise<void> {
  const storeDir = getStoreDir();
  const config = await loadConfig();
  const state = await loadState();
  const events = await readEvents({});
  const globalSettings = await readSettingsSafe(settingsPathFor(false));
  const projectSettings = await readSettingsSafe(settingsPathFor(true));

  const yn = (b: boolean) => (b ? chalk.green("yes") : chalk.gray("no"));
  console.log(chalk.bold.white("\n  cc-skill-trace status\n"));
  console.log(`  version            ${chalk.white(VERSION)}`);
  console.log(`  store              ${chalk.white(storeDir)}`);
  console.log(
    `  events             ${chalk.white(String(events.length))}${events.length ? chalk.gray(`  (latest: ${events.at(-1)?.timestamp})`) : ""}`
  );
  for (const id of ALL_PROVIDER_IDS) {
    const count = events.filter((e) => (e.provider ?? "claude-code") === id).length;
    if (count > 0) console.log(chalk.gray(`    ${id.padEnd(11)} ${count}`));
  }
  console.log(
    `  hook (global)      pre: ${yn(hookRegistered(globalSettings.settings, "PreToolUse"))}  post: ${yn(hookRegistered(globalSettings.settings, "PostToolUse"))}`
  );
  console.log(
    `  hook (project)     pre: ${yn(hookRegistered(projectSettings.settings, "PreToolUse"))}  post: ${yn(hookRegistered(projectSettings.settings, "PostToolUse"))}`
  );
  for (const id of ["codex", "copilot"] as const) {
    const settingsPath = settingsPathFor(false, id);
    const { settings } = await readSettingsSafe(settingsPath);
    console.log(
      `  hook (${id.padEnd(8)})   pre: ${yn(hookRegistered(settings, "PreToolUse"))}  post: ${yn(hookRegistered(settings, "PostToolUse"))} ${chalk.gray(`(best-effort, ${settingsPath})`)}`
    );
  }
  const skillInstalled = await readFile(installedSkillMdPath, "utf-8").then(
    () => true,
    () => false
  );
  const stale = await isSkillMdStale();
  console.log(
    `  SKILL.md           ${skillInstalled ? (stale ? chalk.yellow("outdated") : chalk.green("up to date")) : chalk.gray("not installed")}`
  );
  console.log(
    `  last scan          ${state.lastScanMtimeMs ? chalk.white(new Date(state.lastScanMtimeMs).toLocaleString()) : chalk.gray("never")}`
  );
  console.log(
    `  auto-prune         ${config.autoPruneDays ? chalk.white(`${config.autoPruneDays}d`) : chalk.gray("off")}`
  );
  console.log(`  trigger capture    ${yn(config.captureTriggerMessages)}`);
  console.log(
    `  webhook            ${config.webhookUrl ? chalk.white(config.webhookUrl) : chalk.gray("off")}\n`
  );
}

// ─── doctor (#78, #175) ───────────────────────────────────────────────────────

async function runDoctor(opts: { checkStore?: boolean; fixStore?: boolean }): Promise<void> {
  let problems = 0;
  const ok = (msg: string) => console.log(chalk.green(`  ✓ ${msg}`));
  const bad = (msg: string) => {
    problems++;
    console.log(chalk.red(`  ✗ ${msg}`));
  };
  const warn = (msg: string) => console.log(chalk.yellow(`  ⚠ ${msg}`));

  console.log(chalk.bold.white("\n  cc-skill-trace doctor\n"));

  const storeOnly = Boolean(opts.checkStore || opts.fixStore);

  if (!storeOnly) {
    // Node version
    const major = parseInt(process.versions.node.split(".")[0]!, 10);
    if (major >= 18) ok(`Node.js ${process.version} (>= 18)`);
    else bad(`Node.js ${process.version} — requires >= 18`);

    // settings.json
    for (const scope of [false, true]) {
      const path = settingsPathFor(scope);
      const res = await readSettingsSafe(path);
      const label = scope ? "project" : "global";
      if (res.corrupt) bad(`${label} settings.json is not valid JSON: ${path} (#141)`);
      else if (res.missing && !scope)
        warn(`global settings.json missing: ${path} — run: cc-skill-trace install`);
      else if (!res.missing) {
        const pre = hookRegistered(res.settings, "PreToolUse");
        const post = hookRegistered(res.settings, "PostToolUse");
        if (pre) ok(`${label} PreToolUse hook registered`);
        else if (!scope) warn(`${label} PreToolUse hook not registered`);
        if (pre && !post)
          warn(
            `${label} PostToolUse hook not registered — outcomes won't be recorded (re-run install)`
          );
      }
    }

    // SKILL.md freshness
    const installed = await readFile(installedSkillMdPath, "utf-8").then(
      () => true,
      () => false
    );
    if (!installed) warn("SKILL.md not installed — /skill-trace won't work inside Claude Code");
    else if (await isSkillMdStale()) bad("SKILL.md is outdated — run: cc-skill-trace install");
    else ok("SKILL.md up to date");

    // Other providers (best-effort, #v3-multi-provider) — absence is normal
    // unless the user explicitly ran `install --provider <id>`, so this never
    // counts as a `bad()` problem, only an informational `ok`/nothing.
    for (const id of ["codex", "copilot"] as const) {
      const path = settingsPathFor(false, id);
      const res = await readSettingsSafe(path);
      if (res.corrupt) {
        bad(`${id} hooks file is not valid JSON: ${path}`);
        continue;
      }
      if (res.missing) continue; // not installed for this provider — fine
      const pre = hookRegistered(res.settings, "PreToolUse");
      const post = hookRegistered(res.settings, "PostToolUse");
      if (pre && post) ok(`${id} hooks registered (best-effort — verify with actual use)`);
      else if (pre) warn(`${id} PreToolUse hook registered but PostToolUse is not`);
    }

    // config.json
    const dir = getStoreDir();
    try {
      const raw = await readFile(join(dir, "config.json"), "utf-8");
      JSON.parse(raw);
      ok("config.json is valid JSON");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        vlog("config.json absent (defaults in use)");
      else bad(`config.json is not valid JSON: ${join(dir, "config.json")}`);
    }
  }

  // Store integrity (#175)
  const check = await checkStore();
  if (check.totalLines === 0) {
    ok("event store is empty or absent (nothing to check)");
  } else if (check.corruptLines.length === 0 && check.duplicateIds.length === 0) {
    ok(`event store healthy: ${check.validEvents} events, no corruption`);
  } else {
    if (check.corruptLines.length > 0) {
      bad(
        `event store has ${check.corruptLines.length} corrupt line(s): ${check.corruptLines.slice(0, 10).join(", ")}${check.corruptLines.length > 10 ? "…" : ""}`
      );
    }
    if (check.duplicateIds.length > 0) {
      bad(`event store has ${check.duplicateIds.length} duplicated event ID(s)`);
    }
    if (opts.fixStore) {
      const result = await repairStore();
      console.log(
        chalk.green(
          `\n  ✓ store repaired: kept ${result.kept}, dropped ${result.droppedCorrupt} corrupt + ${result.droppedDuplicates} duplicate(s)`
        )
      );
      console.log(chalk.gray("    original backed up as events.jsonl.bak"));
      problems = 0;
    } else {
      console.log(chalk.gray("\n    Fix with: cc-skill-trace doctor --fix-store"));
    }
  }

  console.log("");
  if (problems > 0) {
    console.log(chalk.red(`  ${problems} problem(s) found.\n`));
    process.exit(1);
  }
  console.log(chalk.green("  All checks passed.\n"));
}

// ─── init wizard (#126) ───────────────────────────────────────────────────────

async function runInit(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      "init is interactive and needs a TTY. Use: cc-skill-trace install [--project] plus config.json instead."
    );
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  console.log(chalk.bold.white("\n  cc-skill-trace setup wizard\n"));
  const scope = (
    await ask(`  Install hooks ${chalk.gray("[G]lobal (~/.claude) or [p]roject (./.claude)?")} `)
  )
    .trim()
    .toLowerCase();
  const project = scope.startsWith("p");
  const pruneRaw = (
    await ask(`  Auto-delete events older than N days ${chalk.gray("(0 = keep forever)")}: `)
  ).trim();
  const autoPruneDays = Math.max(0, parseInt(pruneRaw || "0", 10) || 0);
  const capture = !(await ask(`  Record trigger messages during scans? ${chalk.gray("[Y/n]")} `))
    .trim()
    .toLowerCase()
    .startsWith("n");
  const webhook = (
    await ask(`  Webhook URL to POST events to ${chalk.gray("(empty = none)")}: `)
  ).trim();
  rl.close();

  await saveConfig({
    autoPruneDays: autoPruneDays || undefined,
    captureTriggerMessages: capture,
    webhookUrl: webhook || undefined,
  });
  console.log(chalk.green(`\n✓  Config saved → ${join(getStoreDir(), "config.json")}\n`));

  await runInstall({ project });
  console.log(
    chalk.bold.white("\n  Setup complete. Restart Claude Code, then try: cc-skill-trace show\n")
  );
}

// ─── registration ─────────────────────────────────────────────────────────────

export function registerInstallCommands(program: Command): void {
  program
    .command("install")
    .description("Register the capture hooks and install/update the skill in Claude Code")
    .option(
      "--project",
      "Install hook into .claude/settings.json (project-level) instead of global"
    )
    .option("--check", "Only report whether hooks/skill are installed; exit 1 if not (#153)")
    .option(
      "--skill-template <path>",
      "Install a custom SKILL.md instead of the bundled one (#162)"
    )
    .option(
      "--provider <id>",
      `Agent CLI to install hooks for: claude-code (default), codex, copilot (best-effort, #v3-multi-provider)`,
      parseProviderOpt
    )
    .action(runInstall);

  program
    .command("uninstall")
    .description("Remove the capture hooks from Claude Code settings")
    .option("--project", "Uninstall from .claude/settings.json (project-level) instead of global")
    .option("-f, --force", "Skip the confirmation prompt (#68)")
    .option(
      "--provider <id>",
      "Agent CLI to uninstall hooks from: claude-code (default), codex, copilot (#v3-multi-provider)",
      parseProviderOpt
    )
    .action(runUninstall);

  program
    .command("status")
    .description("Show install state, store location and configuration (#98)")
    .action(runStatus);

  program
    .command("doctor")
    .description("Validate installation and event-store health (#78)")
    .option("--check-store", "Only check events.jsonl integrity (#175)")
    .option("--fix-store", "Repair events.jsonl, dropping corrupt/duplicate lines (#175)")
    .action(runDoctor);

  program.command("init").description("Interactive setup wizard (#126)").action(runInit);
}
