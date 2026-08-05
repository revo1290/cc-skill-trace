import { basename, join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { getStoreDir, loadState, saveState } from "../../core/config.js";
import { extractAllInvocations, listSessionFiles, newestMtimeMs } from "../../core/parser.js";
import type { ExtractAllOptions } from "../../core/parser.js";
import { getProvider } from "../../core/providers/index.js";
import { extractAllInvocationsForProvider } from "../../core/providers/scan.js";
import {
  appendEvent,
  backupEvents,
  clearEvents,
  enrichExistingEvents,
  readEvents,
  selectNewEvents,
  updateEvent,
} from "../../core/store.js";
import type { EventEnrichment } from "../../core/store.js";
import type { ProviderId, SkillInvocationEvent } from "../../core/types.js";
import { getConfig } from "../context.js";
import { buildStats, renderDashboard } from "../format.js";
import { parseDateOpt, parseProviderOpt, validateDateRange } from "../options.js";
import { vlog } from "../ui.js";

/** Render scan progress with percent, ETA and current file (#140). */
function makeProgressRenderer(): (done: number, total: number, file?: string) => void {
  const startedAt = Date.now();
  let lastLen = 0;
  return (done, total, file) => {
    if (!process.stderr.isTTY) {
      if (done === total) process.stderr.write(`  Scanned ${total} files.\n`);
      return;
    }
    const pct = total === 0 ? 100 : Math.round((done / total) * 100);
    const elapsed = Date.now() - startedAt;
    const eta = done === 0 ? 0 : Math.round(((elapsed / done) * (total - done)) / 1000);
    const name = file ? basename(file).slice(0, 32) : "";
    const line = `  Scanning ${done}/${total} (${pct}%)  ETA ${eta}s  ${name}`;
    process.stderr.write(`\r${line}${" ".repeat(Math.max(0, lastLen - line.length))}`);
    lastLen = line.length;
    if (done === total) process.stderr.write("\n");
  };
}

/** Options accepted by {@link scanAndMerge}. */
export interface ScanAndMergeOptions {
  since?: string;
  sessionId?: string;
  /** Only files modified after this epoch ms (scan --resume, #165). */
  modifiedAfterMs?: number;
  /** Restrict to specific files (scan --watch, #128). */
  files?: string[];
  /** Skip writing to the store (scan --dry-run, #152). */
  dryRun?: boolean;
  /** Override config: omit trigger messages (#74). */
  noCapture?: boolean;
  /** Which agent CLI to scan session logs for (default "claude-code", #v3-multi-provider). */
  provider?: ProviderId;
}

/** Result of {@link scanAndMerge}. */
export interface ScanResult {
  /** All events found by this scan (before store dedup). */
  events: SkillInvocationEvent[];
  /** Events that were not already in the store. */
  fresh: SkillInvocationEvent[];
  /** Existing stored events that were backfilled with richer scan data (#223). */
  enriched: EventEnrichment[];
}

/**
 * Scan session logs and merge new events into the store (#30).
 * Shared by scan/show/stats/export/report.
 */
export async function scanAndMerge(opts: ScanAndMergeOptions = {}): Promise<ScanResult> {
  const config = await getConfig();
  const extractOpts: ExtractAllOptions = {
    since: opts.since,
    sessionId: opts.sessionId,
    modifiedAfterMs: opts.modifiedAfterMs,
    files: opts.files,
    onProgress: makeProgressRenderer(),
    triggerMaxLen: config.triggerMessageMaxLen,
    captureTriggerMessages: opts.noCapture ? false : config.captureTriggerMessages,
  };
  const providerId = opts.provider ?? "claude-code";
  const events =
    providerId === "claude-code"
      ? await extractAllInvocations(extractOpts)
      : await extractAllInvocationsForProvider(getProvider(providerId), extractOpts);
  const stored = await readEvents({});
  // Dedup against everything already stored — including hook-captured events,
  // which carry a random UUID rather than the scan's tool_use id, so a plain
  // id match would re-import every one of them (#182).
  const fresh = selectNewEvents(stored, events);
  // Candidates that matched an existing event (and were dropped above) may
  // still carry a triggerMessage/source the existing hook-captured event is
  // missing — backfill those onto the existing event in place (#223).
  const enriched = enrichExistingEvents(stored, events);
  if (!opts.dryRun) {
    for (const ev of fresh) await appendEvent(ev);
    for (const enrichment of enriched) await updateEvent(enrichment.id, enrichment.patch);
  }
  return { events, fresh, enriched };
}

/** Per-skill one-line summary of freshly imported events (#155). */
function freshSummary(fresh: SkillInvocationEvent[]): string[] {
  if (fresh.length === 0) return [];
  const lines: string[] = [chalk.bold.white("  New events by skill:")];
  for (const s of buildStats(fresh)) {
    lines.push(chalk.gray(`    + ${s.name}: ${s.total} (${s.auto} auto, ${s.byUser} user)`));
  }
  return lines;
}

async function runScanOnce(opts: {
  since?: string;
  before?: string;
  skill?: string;
  session?: string;
  clear?: boolean;
  dryRun?: boolean;
  resume?: boolean;
  capture?: boolean;
  provider?: ProviderId;
}): Promise<void> {
  validateDateRange(opts.since, opts.before);
  const providerId = opts.provider ?? "claude-code";
  if (opts.clear && !opts.dryRun) {
    // Back up before clearing so a mid-scan failure can't destroy history (#180).
    const { backupPath, rotatedTo } = await backupEvents();
    if (backupPath) {
      if (rotatedTo) console.log(chalk.gray(`  Previous backup moved to ${rotatedTo}`));
      console.log(chalk.gray(`  Backup saved to ${backupPath}`));
      console.log(
        chalk.gray(`  To restore: cp ${backupPath} ${join(getStoreDir(), "events.jsonl")}`)
      );
    }
    await clearEvents();
    console.log(chalk.gray("  Cleared."));
  }

  let modifiedAfterMs: number | undefined;
  if (opts.resume) {
    const state = await loadState();
    modifiedAfterMs =
      providerId === "claude-code"
        ? state.lastScanMtimeMs
        : state.lastScanMtimeMsByProvider?.[providerId];
    vlog(
      `resume: only files modified after ${modifiedAfterMs ? new Date(modifiedAfterMs).toISOString() : "(never scanned)"}`
    );
  }

  const { events, fresh, enriched } = await scanAndMerge({
    since: opts.since,
    sessionId: opts.session,
    modifiedAfterMs,
    dryRun: opts.dryRun,
    noCapture: opts.capture === false,
    provider: providerId,
  });

  if (!opts.dryRun) {
    if (providerId === "claude-code") {
      const files = await listSessionFiles();
      await saveState({ lastScanMtimeMs: newestMtimeMs(files) });
    } else {
      const provider = getProvider(providerId);
      const files = (await provider.listSessionFiles?.()) ?? [];
      const state = await loadState();
      await saveState({
        lastScanMtimeMsByProvider: {
          ...state.lastScanMtimeMsByProvider,
          [providerId]: newestMtimeMs(files),
        },
      });
    }
  }

  let filtered = events;
  if (opts.before) filtered = filtered.filter((e) => e.timestamp <= opts.before!);
  if (opts.skill) filtered = filtered.filter((e) => e.skillName === opts.skill);

  if (opts.dryRun) {
    console.log(
      chalk.yellow(
        `  [dry-run] Would import ${fresh.length} new invocations (${events.length - fresh.length} already stored), would enrich ${enriched.length} existing. Nothing written.`
      )
    );
    for (const line of freshSummary(fresh)) console.log(line);
    return;
  }

  if (filtered.length === 0 && fresh.length === 0 && enriched.length === 0) {
    console.log(chalk.yellow("  No invocations found."));
    console.log(
      chalk.gray(
        providerId === "claude-code"
          ? "  Tip: set CC_PROJECTS_DIR if your Claude Code logs live outside ~/.claude/projects."
          : `  Tip: cc-skill-trace only detects ${providerId} skills that are also installed on disk (used to cross-reference tool calls). Run "cc-skill-trace list-skills --provider ${providerId}" to check.`
      )
    );
    return;
  }
  console.log(
    chalk.green(
      `✓  Imported ${fresh.length} new invocations (${events.length - fresh.length} already stored), enriched ${enriched.length} existing.`
    )
  );
  for (const line of freshSummary(fresh)) console.log(line);
  console.log(`\n${renderDashboard(filtered)}`);
}

/** Poll session files and import new events as they appear (#128). */
async function runWatch(intervalMs: number): Promise<void> {
  console.log(
    chalk.gray(
      `  Watching session logs (every ${Math.round(intervalMs / 1000)}s) — Ctrl+C to exit.`
    )
  );
  let lastMtime = newestMtimeMs(await listSessionFiles());

  // Initial full catch-up so the watcher starts from a known state.
  const initial = await scanAndMerge({});
  if (initial.fresh.length > 0) {
    console.log(chalk.green(`✓  Backfilled ${initial.fresh.length} events.`));
  }

  const tick = async () => {
    try {
      const files = await listSessionFiles();
      const changed = files.filter((f) => f.mtimeMs > lastMtime);
      if (changed.length === 0) return;
      lastMtime = newestMtimeMs(files);
      const { fresh } = await scanAndMerge({ files: changed.map((f) => f.path) });
      for (const ev of fresh) {
        const src = ev.source === "claude" ? chalk.magenta("🤖 auto") : chalk.cyan("👤 user");
        console.log(
          `  ${chalk.gray(new Date(ev.timestamp).toLocaleTimeString())}  ${chalk.bold.yellow(ev.skillName)}  ${src}`
        );
      }
    } catch (err) {
      vlog(`watch tick failed: ${err}`);
    }
  };

  const interval = setInterval(tick, intervalMs);
  const cleanup = () => {
    clearInterval(interval);
    process.stdout.write("\n");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

export function registerScanCommand(program: Command): void {
  program
    .command("scan")
    .description("Retroactively scan agent CLI session logs (backfill)")
    .option("--since <date>", "Only sessions newer than this date", parseDateOpt)
    .option("--before <date>", "Filter up to this date", parseDateOpt)
    .option("--skill <name>", "Filter by skill name")
    .option("--session <id>", "Filter by session ID")
    .option("--clear", "Clear existing events before scanning")
    .option("--dry-run", "Preview what would be imported without writing (#152)")
    .option("--resume", "Only process session files modified since the last scan (#165)")
    .option(
      "--watch",
      "Keep watching session logs and import new events live (#128, claude-code only)"
    )
    .option("--no-capture", "Do not record trigger messages (privacy, #74)")
    .option(
      "--provider <id>",
      "Agent CLI to scan: claude-code (default), codex — copilot has no session logs to scan (#v3-multi-provider)",
      parseProviderOpt
    )
    .action(async (opts) => {
      const providerId: ProviderId = opts.provider ?? "claude-code";
      if (providerId !== "claude-code" && !getProvider(providerId).supportsScan) {
        console.log(
          chalk.red(
            `✗  ${getProvider(providerId).displayName} does not support scanning session logs (no documented log format). Use hook-capture instead: cc-skill-trace install --provider ${providerId}`
          )
        );
        process.exit(1);
      }
      if (opts.watch) {
        if (providerId !== "claude-code") {
          console.log(chalk.red(`✗  --watch only supports claude-code for now.`));
          process.exit(1);
        }
        const interval = Math.max(
          1000,
          parseInt(process.env.CC_WATCH_INTERVAL_MS ?? "5000", 10) || 5000
        );
        await runWatch(interval);
        return;
      }
      await runScanOnce(opts);
    });
}
