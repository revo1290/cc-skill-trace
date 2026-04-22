#!/usr/bin/env node
import { program } from "commander";
import chalk from "chalk";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readEvents, clearEvents, appendEvent, pruneEvents } from "../core/store.js";
import { extractAllInvocations } from "../core/parser.js";
import { buildHtmlReport } from "./web-report.js";
import { renderDashboard, renderCompact, renderStats } from "./format.js";

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

function scanProgress(done: number, total: number): void {
  process.stderr.write(chalk.gray(`\r  Scanning ${done}/${total} files…`));
  if (done === total) process.stderr.write("\n");
}

function parseDuration(value: string): Date {
  const match = /^(\d+)d$/i.exec(value);
  if (!match) {
    console.error(chalk.red(`✗  Invalid duration: "${value}". Expected format: 30d`));
    process.exit(1);
  }
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - parseInt(match[1]!, 10));
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
    const MAX_STDIN_BYTES = 1024 * 64; // 64 KB — hook payloads are tiny
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_STDIN_BYTES) { process.exit(0); }
    }

    let payload: { session_id?: string; tool_name?: string; tool_input?: { skill?: string; args?: string }; user_invoked?: boolean; cwd?: string; git_branch?: string };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") { process.exit(0); }
      payload = parsed as typeof payload;
    } catch { process.exit(0); }
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
  .option("--since <date>", "Filter from this ISO date (e.g. 2026-04-01)", validateSince)
  .option("--before <date>", "Filter up to this ISO date (e.g. 2026-04-30)", validateSince)
  .option("--skill <name>", "Filter by skill name")
  .option("--session <id>", "Filter by session ID")
  .option("--compact", "Compact table instead of dashboard")
  .option("--scan", "Scan session logs before showing (backfill)")
  .option("--follow", "Refresh dashboard every 2s (live tail)")
  .action(async (opts) => {
    if (opts.scan) {
      const scanned = await extractAllInvocations({ since: opts.since, onProgress: scanProgress });
      const existingIds = new Set((await readEvents()).map((e) => e.id));
      let imported = 0;
      for (const ev of scanned) {
        if (!existingIds.has(ev.id)) { await appendEvent(ev); imported++; }
      }
      process.stderr.write(chalk.gray(`  Imported ${imported} new invocations (${scanned.length - imported} already stored).\n\n`));
    }

    const applyFilters = (all: Awaited<ReturnType<typeof readEvents>>) => {
      let events = all;
      if (opts.since)   events = events.filter(e => e.timestamp >= opts.since);
      if (opts.before)  events = events.filter(e => e.timestamp <= opts.before);
      if (opts.skill)   events = events.filter(e => e.skillName === opts.skill);
      if (opts.session) events = events.filter(e => e.sessionId === opts.session);
      const limit = Math.max(1, parseInt(opts.limit as string, 10) || 50);
      return events.slice(-limit);
    };

    if (opts.follow) {
      let lastEventTs = "";
      const tick = async () => {
        const events = applyFilters(await readEvents());
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
      process.on("SIGINT", () => { clearInterval(interval); process.stdout.write("\n"); process.exit(0); });
      return;
    }

    const events = applyFilters(await readEvents());
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
  .option("--since <date>", "Only sessions newer than this date", validateSince)
  .option("--clear", "Clear existing events before scanning")
  .action(async (opts) => {
    if (opts.clear) { await clearEvents(); console.log(chalk.gray("  Cleared.")); }
    const events = await extractAllInvocations({ since: opts.since, onProgress: scanProgress });
    if (events.length === 0) { console.log(chalk.yellow("  No invocations found.")); return; }
    const existingIds = new Set((await readEvents()).map((e) => e.id));
    let imported = 0;
    for (const ev of events) {
      if (!existingIds.has(ev.id)) { await appendEvent(ev); imported++; }
    }
    console.log(chalk.green(`✓  Imported ${imported} new invocations (${events.length - imported} already stored).`));
    console.log("\n" + renderDashboard(events));
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
  .option("--scan", "Scan session logs first")
  .action(async (opts) => {
    if (opts.scan) {
      const evs = await extractAllInvocations({ since: opts.since, onProgress: scanProgress });
      const existingIds = new Set((await readEvents()).map((e) => e.id));
      let imported = 0;
      for (const ev of evs) {
        if (!existingIds.has(ev.id)) { await appendEvent(ev); imported++; }
      }
      console.log(chalk.gray(`  Scanned: ${evs.length} invocations (${imported} new).`));
    }
    let events = await readEvents();
    if (opts.since)  events = events.filter(e => e.timestamp >= opts.since);
    if (opts.before) events = events.filter(e => e.timestamp <= opts.before);
    if (opts.skill)  events = events.filter(e => e.skillName === opts.skill);

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
  .option("--older-than <duration>", "Remove events older than this (e.g. 30d, 7d)")
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
  .option("--scan", "Scan session logs first")
  .action(async (opts) => {
    if (opts.scan) {
      const scanned = await extractAllInvocations({ since: opts.since, onProgress: scanProgress });
      const existingIds = new Set((await readEvents()).map((e) => e.id));
      let imported = 0;
      for (const ev of scanned) {
        if (!existingIds.has(ev.id)) { await appendEvent(ev); imported++; }
      }
      process.stderr.write(chalk.gray(`  Imported ${imported} new invocations.\n\n`));
    }
    let events = await readEvents();
    if (opts.since)  events = events.filter(e => e.timestamp >= opts.since);
    if (opts.before) events = events.filter(e => e.timestamp <= opts.before);
    if (opts.skill)  events = events.filter(e => e.skillName === opts.skill);
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
  .action(async (opts) => {
    let events = await readEvents();
    if (opts.since)  events = events.filter(e => e.timestamp >= opts.since);
    if (opts.before) events = events.filter(e => e.timestamp <= opts.before);
    if (opts.skill)  events = events.filter(e => e.skillName === opts.skill);

    const fmt = String(opts.format).toLowerCase();
    let out: string;

    if (fmt === "csv") {
      const headers: (keyof typeof events[0])[] = [
        "id", "timestamp", "sessionId", "skillName", "skillArgs",
        "source", "triggerMessage", "cwd", "gitBranch",
      ];
      const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"` : s;
      };
      out = headers.join(",") + "\n" + events.map(e => headers.map(h => esc(e[h])).join(",")).join("\n");
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
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
    console.log(chalk.green("✓  Hook removed from: " + settingsPath));
    console.log(chalk.gray("  Restart Claude Code for the change to take effect."));
  });

program.parse();
