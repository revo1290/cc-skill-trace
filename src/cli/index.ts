#!/usr/bin/env node

// Node.js version gate — Intl.Segmenter requires Node 16+, fetch/structuredClone require 18+ (#39)
const _nodeMajor = parseInt(process.versions.node.split(".")[0]!, 10);
if (_nodeMajor < 18) {
  process.stderr.write(
    `\ncc-skill-trace requires Node.js ≥ 18. You are running ${process.version}.\n` +
    `Upgrade at https://nodejs.org\n\n`
  );
  process.exit(1);
}

import { program } from "commander";
import chalk from "chalk";
import { readFile, writeFile, rename, copyFile as fsCopyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readEvents, clearEvents, appendEvent, pruneEvents } from "../core/store.js";
import { extractAllInvocations } from "../core/parser.js";
import { buildHtmlReport } from "./web-report.js";
import { renderDashboard, renderCompact, renderStats, buildStats } from "./format.js";

const _require = createRequire(import.meta.url);
const VERSION = (_require("../../package.json") as { version: string }).version;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/;

function validateSince(value: string): string {
  if (!ISO_DATE_RE.test(value) || isNaN(Date.parse(value))) {
    console.error(chalk.red(`✗  Invalid date value: "${value}". Expected ISO date, e.g. 2026-04-01`));
    process.exit(1);
  }
  return value;
}

function validateLimit(value: string): string {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1 || String(n) !== value.trim()) {
    console.error(chalk.red(`✗  Invalid --limit value: "${value}". Expected a positive integer, e.g. 50`));
    process.exit(1);
  }
  return value;
}

/** Fail fast if --since is later than --before. */
function validateDateRange(since: string | undefined, before: string | undefined): void {
  if (since && before && since > before) {
    console.error(chalk.red(`✗  --since (${since}) must be earlier than --before (${before})`));
    process.exit(1);
  }
}

/**
 * Atomically write JSON to `path`:
 *  1. Back up the current file as `<path>.bak` (best-effort)
 *  2. Write new content to `<path>.tmp`
 *  3. Rename tmp → path  (atomic on POSIX; best-effort on Windows)
 */
async function writeSettingsAtomic(path: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const tmp  = path + ".tmp";
  // Best-effort backup — don't fail if the original doesn't exist yet
  try { await fsCopyFile(path, path + ".bak"); } catch { /* no original yet */ }
  await writeFile(tmp, json, "utf-8");
  await rename(tmp, path);
}

function scanProgress(done: number, total: number): void {
  process.stderr.write(chalk.gray(`\r  Scanning ${done}/${total} files…`));
  if (done === total) process.stderr.write("\n");
}

/** Scan session logs and merge new events into the store. Returns all scanned events + import count. (#30) */
async function scanAndMerge(opts: {
  since?: string;
  sessionId?: string;
}): Promise<{ events: Awaited<ReturnType<typeof readEvents>>; imported: number }> {
  const events = await extractAllInvocations({ ...opts, onProgress: scanProgress });
  const existingIds = new Set((await readEvents()).map((e) => e.id));
  let imported = 0;
  for (const ev of events) {
    if (!existingIds.has(ev.id)) { await appendEvent(ev); imported++; }
  }
  return { events, imported };
}

function parseDuration(value: string): Date {
  const match = /^(\d+)(h|d|w)$/i.exec(value);
  if (!match) {
    console.error(chalk.red(`✗  Invalid duration: "${value}". Expected format: 12h, 30d, or 4w`));
    process.exit(1);
  }
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  const cutoff = new Date();
  if (unit === "h") cutoff.setHours(cutoff.getHours() - n);
  else if (unit === "d") cutoff.setDate(cutoff.getDate() - n);
  else cutoff.setDate(cutoff.getDate() - n * 7);
  return cutoff;
}

program
  .name("cc-skill-trace")
  .description("Skill invocation debugger & visualizer for Claude Code")
  .version(VERSION);

// ─── install ──────────────────────────────────────────────────────────────────
program
  .command("install")
  .description("Register the capture hook in your Claude Code settings")
  .option("--project", "Install into .claude/settings.json (project-level) instead of global")
  .action(async (opts) => {
    const settingsPath = opts.project
      ? resolve(".claude/settings.json")
      : join(homedir(), ".claude", "settings.json");

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    } catch { /* start fresh */ }

    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    const preToolUse = (hooks.PreToolUse ?? []) as Array<Record<string, unknown>>;

    if (preToolUse.some((h) => JSON.stringify(h).includes("cc-skill-trace"))) {
      console.log(chalk.yellow("⚠  Hook already registered → " + settingsPath));
      return;
    }

    preToolUse.push({
      matcher: "Skill",
      hooks: [{ type: "command", command: "cc-skill-trace hook-capture" }],
    });
    settings.hooks = { ...hooks, PreToolUse: preToolUse };

    await writeSettingsAtomic(settingsPath, settings);
    console.log(chalk.green("✓  Hook installed → " + settingsPath));
    console.log(chalk.gray("  Restart Claude Code for the hook to take effect."));

    // Also install the skill
    const skillDir = join(homedir(), ".claude", "skills", "skill-trace");
    const { mkdir } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const skillSrc = join(here, "..", "skill", "SKILL.md");
    try {
      await mkdir(skillDir, { recursive: true });
      await fsCopyFile(skillSrc, join(skillDir, "SKILL.md"));
      console.log(chalk.green("✓  Skill installed   → " + skillDir));
      console.log(chalk.gray("  Use /skill-trace inside Claude Code to open the dashboard."));
    } catch {
      console.log(chalk.yellow("  Skill file not found — run from the package root or install from npm."));
    }
  });

// ─── hook-capture (called by Claude Code automatically) ──────────────────────
program
  .command("hook-capture", { hidden: true })
  .description("Internal: receives PreToolUse hook payload via stdin")
  .helpOption(false)
  .action(async () => {
    const DEBUG = process.env["CC_DEBUG"] === "1";
    const dbg = (msg: string) => { if (DEBUG) process.stderr.write(`[cc-skill-trace] ${msg}\n`); };

    let raw = "";
    const MAX_STDIN_BYTES = 1024 * 64; // 64 KB — hook payloads are tiny
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_STDIN_BYTES) {
        dbg("stdin exceeded 64 KB limit, ignoring");
        process.exit(0);
      }
    }

    let payload: {
      session_id?: string;
      tool_name?: string;
      tool_input?: { skill?: string; args?: string };
      user_invoked?: boolean;
      cwd?: string;
      git_branch?: string;
    };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") {
        dbg("payload is not an object, ignoring");
        process.exit(0);
      }
      payload = parsed as typeof payload;
    } catch (err) {
      dbg(`JSON parse error: ${err}`);
      process.exit(0);
    }

    if (payload.tool_name !== "Skill" || !payload.tool_input?.skill) {
      dbg(`not a Skill invocation (tool_name=${payload.tool_name}), ignoring`);
      process.exit(0);
    }

    const { randomUUID } = await import("node:crypto");
    const event = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      sessionId: payload.session_id ?? "unknown",
      skillName: String(payload.tool_input.skill),
      skillArgs: payload.tool_input.args ? String(payload.tool_input.args) : undefined,
      source: (payload.user_invoked ? "user" : "claude") as "user" | "claude",
      cwd: payload.cwd,
      gitBranch: payload.git_branch,
    };

    dbg(`capturing ${event.source} invocation of "${event.skillName}" in session ${event.sessionId}`);
    try { await appendEvent(event); dbg("event appended"); } catch (err) { dbg(`appendEvent failed: ${err}`); }
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  });

// ─── show (main command — terminal dashboard) ─────────────────────────────────
program
  .command("show", { isDefault: true })
  .description("Show the terminal skill-trace dashboard (default command)")
  .option("-n, --limit <n>", "Max recent events to show", validateLimit, "50")
  .option("--since <date>", "Filter from this ISO date (e.g. 2026-04-01)", validateSince)
  .option("--before <date>", "Filter up to this ISO date (e.g. 2026-04-30)", validateSince)
  .option("--skill <name>", "Filter by skill name")
  .option("--session <id>", "Filter by session ID")
  .option("--compact", "Compact table instead of dashboard")
  .option("--json", "Output events as JSON array (pipe-friendly)")
  .option("--scan", "Scan session logs before showing (backfill)")
  .option("--follow", "Refresh dashboard every 2s (live tail)")
  .action(async (opts) => {
    validateDateRange(opts.since, opts.before);

    if (opts.scan) {
      const { events: scanned, imported } = await scanAndMerge({ since: opts.since, sessionId: opts.session });
      process.stderr.write(chalk.gray(`  Imported ${imported} new invocations (${scanned.length - imported} already stored).\n\n`));
    }

    const readOpts = {
      since: opts.since as string | undefined,
      before: opts.before as string | undefined,
      skill: opts.skill as string | undefined,
      sessionId: opts.session as string | undefined,
      limit: parseInt(opts.limit as string, 10),
    };

    if (opts.follow) {
      let lastEventTs = "";
      const tick = async () => {
        const events = await readEvents(readOpts);
        const newTs = events.at(-1)?.timestamp ?? "";
        if (newTs !== lastEventTs) {
          lastEventTs = newTs;
          process.stdout.write("\x1B[2J\x1B[0f"); // clear screen, cursor home
          process.stdout.write((opts.compact ? renderCompact(events) : renderDashboard(events)) + "\n");
        }
        process.stdout.write(chalk.gray(`  [Following — Ctrl+C to exit] `) + chalk.gray(new Date().toLocaleTimeString()) + "  \r");
      };
      await tick();
      const interval = setInterval(tick, 2000);
      const cleanup = () => { clearInterval(interval); process.stdout.write("\n"); process.exit(0); };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      return;
    }

    const events = await readEvents(readOpts);

    if (opts.json) {
      process.stdout.write(JSON.stringify(events, null, 2) + "\n");
    } else if (opts.compact) {
      console.log(renderCompact(events));
    } else {
      console.log(renderDashboard(events));
    }
  });

// ─── scan ─────────────────────────────────────────────────────────────────────
program
  .command("scan")
  .description("Retroactively scan Claude Code session logs (backfill)")
  .option("--since <date>", "Only sessions newer than this date", validateSince)
  .option("--before <date>", "Filter up to this ISO date", validateSince)
  .option("--skill <name>", "Filter by skill name")
  .option("--session <id>", "Filter by session ID")
  .option("--clear", "Clear existing events before scanning")
  .action(async (opts) => {
    validateDateRange(opts.since, opts.before);
    if (opts.clear) { await clearEvents(); console.log(chalk.gray("  Cleared.")); }
    const { events, imported } = await scanAndMerge({ since: opts.since, sessionId: opts.session });
    let filtered = events;
    if (opts.before) filtered = filtered.filter(e => e.timestamp <= opts.before);
    if (opts.skill)  filtered = filtered.filter(e => e.skillName === opts.skill);
    if (filtered.length === 0) { console.log(chalk.yellow("  No invocations found.")); return; }
    console.log(chalk.green(`✓  Imported ${imported} new invocations (${events.length - imported} already stored).`));
    console.log("\n" + renderDashboard(filtered));
  });

// ─── report (browser HTML) ────────────────────────────────────────────────────
program
  .command("report")
  .description("Generate an interactive HTML report and open in browser")
  .option("-o, --output <path>", "Output path", join(homedir(), ".cc-skill-trace", "report.html"))
  .option("--no-open", "Don't open browser")
  .option("--since <date>", "Filter from date", validateSince)
  .option("--before <date>", "Filter up to date", validateSince)
  .option("--skill <name>", "Filter by skill name")
  .option("--session <id>", "Filter by session ID")
  .option("--scan", "Scan session logs first")
  .action(async (opts) => {
    validateDateRange(opts.since, opts.before);
    if (opts.scan) {
      const { events: scanned, imported } = await scanAndMerge({ since: opts.since, sessionId: opts.session });
      console.log(chalk.gray(`  Scanned: ${scanned.length} invocations (${imported} new).`));
    }
    const events = await readEvents({
      since: opts.since as string | undefined,
      before: opts.before as string | undefined,
      skill: opts.skill as string | undefined,
      sessionId: opts.session as string | undefined,
    });

    const html = buildHtmlReport(events);
    await writeFile(opts.output, html, "utf-8");
    console.log(chalk.green(`✓  Report → ${opts.output}  (${events.length} events)`));

    if (opts.open !== false) {
      try {
        if (process.platform === "darwin") {
          execFileSync("open", [opts.output], { stdio: "ignore" });
        } else if (process.platform === "win32") {
          execFileSync("cmd", ["/c", "start", "", opts.output], { stdio: "ignore" });
        } else {
          execFileSync("xdg-open", [opts.output], { stdio: "ignore" });
        }
      } catch { console.log(chalk.gray(`  Open manually: ${opts.output}`)); }
    }
  });

// ─── clear ────────────────────────────────────────────────────────────────────
program
  .command("clear")
  .description("Clear all captured events")
  .option("--older-than <duration>", "Remove events older than this (e.g. 12h, 30d, 4w)")
  .action(async (opts) => {
    if (opts.olderThan) {
      const cutoff = parseDuration(String(opts.olderThan));
      const { removed, kept } = await pruneEvents(cutoff.toISOString());
      console.log(chalk.green(`✓  Removed ${removed} events older than ${opts.olderThan} (${kept} kept).`));
    } else {
      await clearEvents();
      console.log(chalk.green("✓  Cleared."));
    }
  });

// ─── stats ────────────────────────────────────────────────────────────────────
program
  .command("stats")
  .description("Show aggregated daily activity and top sessions")
  .option("--since <date>", "Filter from this ISO date", validateSince)
  .option("--before <date>", "Filter up to this ISO date", validateSince)
  .option("--skill <name>", "Filter by skill name")
  .option("--session <id>", "Filter by session ID")
  .option("--scan", "Scan session logs first")
  .action(async (opts) => {
    validateDateRange(opts.since, opts.before);
    if (opts.scan) {
      const { imported } = await scanAndMerge({ since: opts.since, sessionId: opts.session });
      process.stderr.write(chalk.gray(`  Imported ${imported} new invocations.\n\n`));
    }
    const events = await readEvents({
      since: opts.since as string | undefined,
      before: opts.before as string | undefined,
      skill: opts.skill as string | undefined,
      sessionId: opts.session as string | undefined,
    });
    console.log(renderStats(events));
  });

// ─── export ───────────────────────────────────────────────────────────────────
program
  .command("export")
  .description("Export captured events as JSON or CSV")
  .option("--format <fmt>", "Output format: json | csv", "json")
  .option("-o, --output <path>", "Output file path (default: stdout)")
  .option("--since <date>", "Filter from this ISO date", validateSince)
  .option("--before <date>", "Filter up to this ISO date", validateSince)
  .option("--skill <name>", "Filter by skill name")
  .option("--session <id>", "Filter by session ID")
  .option("--scan", "Scan session logs first")
  .action(async (opts) => {
    validateDateRange(opts.since, opts.before);
    if (opts.scan) {
      const { imported } = await scanAndMerge({ since: opts.since, sessionId: opts.session });
      process.stderr.write(chalk.gray(`  Imported ${imported} new invocations.\n\n`));
    }
    const events = await readEvents({
      since: opts.since as string | undefined,
      before: opts.before as string | undefined,
      skill: opts.skill as string | undefined,
      sessionId: opts.session as string | undefined,
    });

    const fmt = String(opts.format).toLowerCase();
    let out: string;

    if (fmt === "csv") {
      const headers: (keyof typeof events[0])[] = [
        "id", "timestamp", "sessionId", "skillName", "skillArgs",
        "source", "triggerMessage", "injectedTokens", "cwd", "gitBranch",
      ];
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      // UTF-8 BOM ensures Excel opens the file without garbling non-ASCII characters
      out = "\uFEFF" + headers.map(h => `"${h}"`).join(",") + "\n"
        + events.map(e => headers.map(h => esc(e[h])).join(",")).join("\n");
    } else if (fmt === "json") {
      out = JSON.stringify(events, null, 2);
    } else {
      console.error(chalk.red(`✗  Unknown format: "${opts.format}". Use json or csv.`));
      process.exit(1);
    }

    if (opts.output) {
      await writeFile(opts.output, out, "utf-8");
      console.error(chalk.green(`✓  Exported ${events.length} events → ${opts.output}`));
    } else {
      process.stdout.write(out + "\n");
    }
  });

// ─── list-skills ──────────────────────────────────────────────────────────────
program
  .command("list-skills")
  .alias("ls")
  .description("List all unique skills seen, with invocation counts")
  .option("--since <date>", "Filter from this ISO date", validateSince)
  .option("--before <date>", "Filter up to this ISO date", validateSince)
  .option("--scan", "Scan session logs first")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    validateDateRange(opts.since, opts.before);
    if (opts.scan) {
      const { imported } = await scanAndMerge({ since: opts.since });
      process.stderr.write(chalk.gray(`  Imported ${imported} new invocations.\n\n`));
    }
    const events = await readEvents({
      since: opts.since as string | undefined,
      before: opts.before as string | undefined,
    });

    const stats = buildStats(events);

    if (opts.json) {
      process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
      return;
    }

    if (stats.length === 0) {
      console.log(chalk.gray("  No skills recorded yet."));
      console.log(chalk.gray("  Run: cc-skill-trace install  then use Claude Code."));
      return;
    }

    const maxName = Math.max(...stats.map(s => s.name.length));
    console.log(
      chalk.gray("  " + "skill".padEnd(maxName) + "   total  auto  user")
    );
    console.log(chalk.gray("  " + "─".repeat(maxName + 20)));
    for (const s of stats) {
      console.log(
        "  " + chalk.bold.yellow(s.name.padEnd(maxName)) +
        "  " + chalk.white(String(s.total).padStart(5)) + chalk.gray("x") +
        "  " + chalk.magenta(String(s.auto).padStart(4)) +
        "  " + chalk.cyan(String(s.byUser).padStart(4))
      );
    }
  });

// ─── uninstall ────────────────────────────────────────────────────────────────
program
  .command("uninstall")
  .description("Remove the capture hook from Claude Code settings")
  .option("--project", "Uninstall from .claude/settings.json (project-level) instead of global")
  .action(async (opts) => {
    const settingsPath = opts.project
      ? resolve(".claude/settings.json")
      : join(homedir(), ".claude", "settings.json");

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    } catch {
      console.log(chalk.yellow("⚠  Settings file not found: " + settingsPath));
      return;
    }

    const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    const preToolUse = (hooks.PreToolUse ?? []) as Array<Record<string, unknown>>;
    const filtered = preToolUse.filter(h => !JSON.stringify(h).includes("cc-skill-trace"));

    if (filtered.length === preToolUse.length) {
      console.log(chalk.yellow("⚠  Hook not found in: " + settingsPath));
      return;
    }

    settings.hooks = { ...hooks, PreToolUse: filtered };
    await writeSettingsAtomic(settingsPath, settings);
    console.log(chalk.green("✓  Hook removed from: " + settingsPath));

    // Remove the installed skill file
    const { rm: rmFs } = await import("node:fs/promises");
    const skillDir = join(homedir(), ".claude", "skills", "skill-trace");
    try {
      await rmFs(skillDir, { recursive: true, force: true });
      console.log(chalk.green("✓  Skill removed   → " + skillDir));
    } catch {
      console.log(chalk.yellow("⚠  Could not remove skill directory: " + skillDir));
    }

    console.log(chalk.gray("  Restart Claude Code for the change to take effect."));
  });

program.parse();
