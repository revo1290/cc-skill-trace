#!/usr/bin/env node
import { program } from "commander";
import chalk from "chalk";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readEvents, clearEvents, appendEvent, STORE_DIR } from "../core/store.js";
import { extractAllInvocations } from "../core/parser.js";
import { buildHtmlReport } from "./web-report.js";
import { renderDashboard, renderCompact } from "./format.js";

const VERSION = "0.1.1";

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

    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    console.log(chalk.green("✓  Hook installed → " + settingsPath));
    console.log(chalk.gray("  Restart Claude Code for the hook to take effect."));

    // Also install the skill
    const skillDir = join(homedir(), ".claude", "skills", "skill-trace");
    const { mkdir, copyFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const skillSrc = join(here, "..", "skill", "SKILL.md");
    try {
      await mkdir(skillDir, { recursive: true });
      await copyFile(skillSrc, join(skillDir, "SKILL.md"));
      console.log(chalk.green("✓  Skill installed   → " + skillDir));
      console.log(chalk.gray("  Use /skill-trace inside Claude Code to open the dashboard."));
    } catch {
      console.log(chalk.yellow("  Skill file not found — run from the package root or install from npm."));
    }
  });

// ─── hook-capture (called by Claude Code automatically) ──────────────────────
program
  .command("hook-capture")
  .description("Internal: receives PreToolUse hook payload via stdin")
  .helpOption(false)
  .action(async () => {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;

    let payload: { session_id?: string; tool_name?: string; tool_input?: { skill?: string; args?: string }; user_invoked?: boolean; cwd?: string; git_branch?: string };
    try { payload = JSON.parse(raw); } catch { process.exit(0); }
    if (payload.tool_name !== "Skill" || !payload.tool_input?.skill) { process.exit(0); }

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

    try { await appendEvent(event); } catch { /* never block Claude Code */ }
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  });

// ─── show (main command — terminal dashboard) ─────────────────────────────────
program
  .command("show", { isDefault: true })
  .description("Show the terminal skill-trace dashboard (default command)")
  .option("-n, --limit <n>", "Max recent events to show", "50")
  .option("--since <date>", "Filter from this ISO date (e.g. 2026-04-01)")
  .option("--skill <name>", "Filter by skill name")
  .option("--session <id>", "Filter by session ID")
  .option("--compact", "Compact table instead of dashboard")
  .option("--scan", "Scan session logs before showing (backfill)")
  .action(async (opts) => {
    if (opts.scan) {
      process.stderr.write(chalk.gray("  Scanning ~/.claude/projects/ …\n"));
      const scanned = await extractAllInvocations({ since: opts.since });
      for (const ev of scanned) await appendEvent(ev);
      process.stderr.write(chalk.gray(`  Imported ${scanned.length} invocations.\n\n`));
    }

    let events = await readEvents();
    if (opts.since)   events = events.filter(e => e.timestamp >= opts.since);
    if (opts.skill)   events = events.filter(e => e.skillName === opts.skill);
    if (opts.session) events = events.filter(e => e.sessionId === opts.session);
    events = events.slice(-Number(opts.limit));

    if (opts.compact) {
      console.log(renderCompact(events));
    } else {
      console.log(renderDashboard(events));
    }
  });

// ─── scan ─────────────────────────────────────────────────────────────────────
program
  .command("scan")
  .description("Retroactively scan Claude Code session logs (backfill)")
  .option("--since <date>", "Only sessions newer than this date")
  .option("--clear", "Clear existing events before scanning")
  .action(async (opts) => {
    if (opts.clear) { await clearEvents(); console.log(chalk.gray("  Cleared.")); }
    console.log(chalk.gray("  Scanning ~/.claude/projects/ …"));
    const events = await extractAllInvocations({ since: opts.since });
    if (events.length === 0) { console.log(chalk.yellow("  No invocations found.")); return; }
    for (const ev of events) await appendEvent(ev);
    console.log(chalk.green(`✓  Imported ${events.length} invocations.`));
    // Show the dashboard right away
    console.log("\n" + renderDashboard(events));
  });

// ─── report (browser HTML) ────────────────────────────────────────────────────
program
  .command("report")
  .description("Generate an interactive HTML report and open in browser")
  .option("-o, --output <path>", "Output path", "/tmp/cc-skill-trace-report.html")
  .option("--no-open", "Don't open browser")
  .option("--since <date>", "Filter from date")
  .option("--scan", "Scan session logs first")
  .action(async (opts) => {
    if (opts.scan) {
      const evs = await extractAllInvocations({ since: opts.since });
      for (const ev of evs) await appendEvent(ev);
      console.log(chalk.gray(`  Scanned: ${evs.length} invocations.`));
    }
    let events = await readEvents();
    if (opts.since) events = events.filter(e => e.timestamp >= opts.since);

    const html = buildHtmlReport(events);
    await writeFile(opts.output, html, "utf-8");
    console.log(chalk.green(`✓  Report → ${opts.output}`));

    if (opts.open !== false) {
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try { execFileSync(cmd, [opts.output], { stdio: "ignore" }); }
      catch { console.log(chalk.gray(`  Open: ${opts.output}`)); }
    }
  });

// ─── clear ────────────────────────────────────────────────────────────────────
program
  .command("clear")
  .description("Clear all captured events")
  .action(async () => {
    await clearEvents();
    console.log(chalk.green("✓  Cleared."));
  });

program.parse();
