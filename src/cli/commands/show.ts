import { writeFile } from "node:fs/promises";
import chalk from "chalk";
import type { Command } from "commander";
import { parseDuration } from "../../core/filter.js";
import { readEvents } from "../../core/store.js";
import type { ReadEventsOptions } from "../../core/store.js";
import type { SkillInvocationEvent } from "../../core/types.js";
import { getConfig, VERSION } from "../context.js";
import {
  COMPACT_COLUMNS,
  renderCompact,
  renderDashboard,
  renderDiff,
  renderGroupBySession,
  renderTerse,
} from "../format.js";
import type { CompactColumn } from "../format.js";
import { addFilterOptions, filterFromOpts, parseLimitOpt } from "../options.js";
import { checkForUpdate, fail, maybeAutoPrune, stripAnsi, updateHint, vlog } from "../ui.js";
import { skipWhileRunning } from "../follow.js";
import { isSkillMdStale } from "./install.js";
import { scanAndMerge } from "./scan.js";

function parseColumns(value: string): CompactColumn[] {
  const cols = value
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  for (const c of cols) {
    if (!(COMPACT_COLUMNS as readonly string[]).includes(c)) {
      fail(`Unknown column "${c}". Available: ${COMPACT_COLUMNS.join(", ")}`);
    }
  }
  return cols as CompactColumn[];
}

/** Render the selected view once (shared by one-shot and --follow). */
function renderView(events: SkillInvocationEvent[], opts: Record<string, unknown>): string {
  if (opts.json) return JSON.stringify(events, null, 2);
  if (opts.terse) return renderTerse(events);
  if (opts.groupBy === "session") return renderGroupBySession(events);
  if (opts.compact || opts.columns) {
    return renderCompact(events, opts.columns ? parseColumns(String(opts.columns)) : undefined);
  }
  return renderDashboard(events, {
    page: opts.page ? parseInt(String(opts.page), 10) : undefined,
    perPage: opts.perPage ? parseInt(String(opts.perPage), 10) : undefined,
  });
}

async function runFollow(
  readOpts: ReadEventsOptions,
  opts: Record<string, unknown>
): Promise<void> {
  const config = await getConfig();
  const intervalMs = opts.interval
    ? Math.max(250, parseInt(String(opts.interval), 10) || 2000)
    : config.followIntervalMs;

  // Hide the cursor during live refresh; ALWAYS restore it on exit (#130).
  process.stdout.write("\x1B[?25l");
  const restoreCursor = () => process.stdout.write("\x1B[?25h");
  process.on("exit", restoreCursor);

  let lastEventTs = "";
  let lastRender = "";
  const tick = async (force = false) => {
    const events = await readEvents(readOpts);
    const newTs = events.at(-1)?.timestamp ?? "";
    if (force || newTs !== lastEventTs) {
      lastEventTs = newTs;
      lastRender = renderView(events, opts);
      process.stdout.write("\x1B[2J\x1B[0f"); // clear screen, cursor home
      process.stdout.write(`${lastRender}\n`);
    }
    process.stdout.write(
      chalk.gray("  [Following — Ctrl+C to exit] ") +
        chalk.gray(new Date().toLocaleTimeString()) +
        "  \r"
    );
  };
  await tick(true);
  // Guard against overlapping ticks: if a tick takes longer than the interval
  // (large events.jsonl / slow FS), setInterval would otherwise start the next
  // one before the previous finished, interleaving stdout writes (#186).
  const guardedTick = skipWhileRunning(() => tick(false));
  const interval = setInterval(guardedTick, intervalMs);

  // Re-render on terminal resize so the layout adapts (#90).
  const onResize = () => {
    void tick(true);
  };
  process.stdout.on("resize", onResize);

  const cleanup = () => {
    clearInterval(interval);
    process.stdout.removeListener("resize", onResize);
    restoreCursor();
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

export function registerShowCommand(program: Command): void {
  const cmd = program
    .command("show", { isDefault: true })
    .description("Show the terminal skill-trace dashboard (default command)")
    .option("-n, --limit <n>", "Max recent events to load", parseLimitOpt, "50");

  addFilterOptions(cmd)
    .option("--compact", "Compact table instead of dashboard")
    .option("--columns <list>", `Columns for compact view: ${COMPACT_COLUMNS.join(",")} (#168)`)
    .option("--terse", "Ultra-compact no-ANSI output (used by /skill-trace to minimise token cost)")
    .option("--json", "Output events as JSON array (pipe-friendly)")
    .option("--group-by <what>", 'Group events; supported: "session" (#121)')
    .option("--page <n>", "Page of the recent-invocations list (#134)", parseLimitOpt)
    .option(
      "--per-page <n>",
      "Rows per page for recent invocations (default 12) (#134)",
      parseLimitOpt
    )
    .option("--diff", "Compare this period against the previous one (#44)")
    .option("--diff-window <duration>", "Window size for --diff (default 7d)", "7d")
    .option("-o, --output <path>", "Write the rendered output (ANSI-stripped) to a file (#142)")
    .option("--scan", "Scan session logs before showing (backfill)")
    .option("--follow", "Live-refresh the dashboard (Ctrl+C to exit)")
    .option("--interval <ms>", "Refresh interval for --follow in milliseconds (#87)")
    .action(async (opts) => {
      const filter = filterFromOpts(opts);
      if (opts.groupBy && opts.groupBy !== "session") {
        fail(`Unsupported --group-by "${opts.groupBy}". Supported: session`);
      }

      const config = await getConfig();
      await maybeAutoPrune(config).catch((err) => vlog(`auto-prune failed: ${err}`));

      // Warn when the installed SKILL.md is out of date with the current package.
      if (!opts.json && !opts.terse && (await isSkillMdStale())) {
        process.stderr.write(
          chalk.yellow("⚠  SKILL.md is outdated — run: cc-skill-trace install\n\n")
        );
      }

      if (opts.scan) {
        const { events: scanned, fresh } = await scanAndMerge({
          since: filter.since,
          sessionId: filter.sessionId,
        });
        process.stderr.write(
          chalk.gray(
            `  Imported ${fresh.length} new invocations (${scanned.length - fresh.length} already stored).\n\n`
          )
        );
      }

      // ── Period diff mode (#44) ─────────────────────────────────────────
      if (opts.diff) {
        let windowStart: Date;
        try {
          windowStart = parseDuration(String(opts.diffWindow));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
        const now = new Date();
        const windowMs = now.getTime() - windowStart.getTime();
        const midIso = windowStart.toISOString();
        const startIso = new Date(windowStart.getTime() - windowMs).toISOString();
        const events = await readEvents({ ...filter, since: undefined, before: undefined });
        console.log(
          renderDiff(
            events,
            { since: startIso, before: midIso },
            { since: midIso, before: now.toISOString() },
            { a: `previous ${opts.diffWindow}`, b: `last ${opts.diffWindow}` }
          )
        );
        return;
      }

      const readOpts: ReadEventsOptions = { ...filter, limit: parseInt(String(opts.limit), 10) };

      if (opts.follow) {
        await runFollow(readOpts, opts as Record<string, unknown>);
        return;
      }

      const events = await readEvents(readOpts);
      const out = renderView(events, opts as Record<string, unknown>);

      if (opts.output) {
        const content = opts.json ? out : stripAnsi(out);
        await writeFile(String(opts.output), `${content}\n`, "utf-8");
        process.stderr.write(chalk.green(`✓  Saved ${events.length} events → ${opts.output}\n`));
      } else {
        process.stdout.write(`${out}\n`);
      }

      // One-line update hint, daily-cached and fully silent on failure (#81).
      if (!opts.json && !opts.terse && !opts.output && process.stdout.isTTY) {
        const latest = await checkForUpdate(VERSION, config);
        if (latest) console.log(updateHint(latest, VERSION));
      }
    });

  // ── replay (#45) ───────────────────────────────────────────────────────
  program
    .command("replay [sessionId]")
    .description("Step through the skill invocations of one session (#45)")
    .action(async (sessionId: string | undefined) => {
      let events = await readEvents(sessionId ? { sessionId } : {});
      if (events.length === 0) {
        console.log(
          chalk.yellow(
            sessionId ? `  No events for session ${sessionId}.` : "  No events recorded yet."
          )
        );
        return;
      }
      if (!sessionId) {
        const latest = events.at(-1)?.sessionId;
        events = events.filter((e) => e.sessionId === latest);
        console.log(chalk.gray(`  (latest session: ${latest})\n`));
      }
      events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

      const printEvent = (ev: SkillInvocationEvent, i: number) => {
        const src = ev.source === "claude" ? chalk.magenta("🤖 auto") : chalk.cyan("👤 user");
        console.log(
          `  ${chalk.gray(`[${i + 1}/${events.length}]`)} ${chalk.gray(new Date(ev.timestamp).toLocaleString())}  ${chalk.bold.yellow(ev.skillName)}  ${src}`
        );
        if (ev.skillArgs) console.log(chalk.gray(`      args: ${ev.skillArgs}`));
        if (ev.triggerMessage)
          console.log(
            chalk.italic.gray(`      "${ev.triggerMessage.replace(/\n/g, " ").slice(0, 120)}"`)
          );
        if (ev.injectedTokens)
          console.log(chalk.gray(`      ~${ev.injectedTokens.toLocaleString()} tokens injected`));
      };

      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        events.forEach(printEvent);
        return;
      }

      console.log(chalk.gray("  Enter/space: next · q: quit\n"));
      let i = 0;
      const first = events[i];
      if (!first) return;
      printEvent(first, i);
      i++;
      if (i >= events.length) return;

      process.stdin.setRawMode(true);
      process.stdin.resume();
      await new Promise<void>((resolve) => {
        process.stdin.on("data", (buf: Buffer) => {
          const key = buf.toString();
          if (key === "q" || key === "\x03" /* Ctrl+C */) {
            resolve();
            return;
          }
          const ev = events[i];
          if (!ev) {
            resolve();
            return;
          }
          printEvent(ev, i);
          i++;
          if (i >= events.length) resolve();
        });
      });
      process.stdin.setRawMode(false);
      process.stdin.pause();
      console.log(chalk.gray("\n  End of session replay."));
    });
}
