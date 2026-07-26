import { access, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import type { Command } from "commander";
import { parseDuration } from "../../core/filter.js";
import {
  clearEvents,
  mergeStores,
  pruneEvents,
  readEvents,
  updateEvent,
} from "../../core/store.js";
import type { SkillInvocationEvent } from "../../core/types.js";
import { getConfig } from "../context.js";
import { addFilterOptions, filterFromOpts, parseLimitOpt } from "../options.js";
import { applyFilter } from "../../core/filter.js";
import { buildHtmlReport } from "../web-report.js";
import { confirm, fail, openInBrowser } from "../ui.js";
import { scanAndMerge } from "./scan.js";

// ─── Serializers ─────────────────────────────────────────────────────────────

const CSV_HEADERS: (keyof SkillInvocationEvent)[] = [
  "id",
  "timestamp",
  "sessionId",
  "skillName",
  "skillArgs",
  "source",
  "triggerMessage",
  "injectedTokens",
  "cwd",
  "gitBranch",
  "recordedVia",
  "tags",
  "outcome",
  "durationMs",
];

/** RFC 4180-compliant CSV: CRLF records, quotes doubled, fields quoted when needed (#79). */
export function toCsv(events: SkillInvocationEvent[], bom: boolean): string {
  const esc = (v: unknown): string => {
    if (v == null) return "";
    const s = Array.isArray(v) ? v.join(";") : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    CSV_HEADERS.map((h) => `"${h}"`).join(","),
    ...events.map((e) => CSV_HEADERS.map((h) => esc(e[h])).join(",")),
  ];
  // UTF-8 BOM (default) keeps Excel from garbling non-ASCII text; --no-bom for
  // POSIX tooling (#193). RFC 4180 prescribes CRLF record separators.
  return `${(bom ? "\uFEFF" : "") + rows.join("\r\n")}\r\n`;
}

/** SQLite-compatible SQL dump: pipe into `sqlite3 skills.db` (#97). */
export function toSql(events: SkillInvocationEvent[]): string {
  const q = (v: unknown): string => {
    if (v == null) return "NULL";
    if (typeof v === "number") return String(v);
    const s = Array.isArray(v) ? v.join(";") : String(v);
    return `'${s.replace(/'/g, "''")}'`;
  };
  const lines = [
    "-- cc-skill-trace export (SQLite-compatible)",
    "-- Usage: cc-skill-trace export --format sql | sqlite3 skills.db",
    "CREATE TABLE IF NOT EXISTS skill_events (",
    "  id TEXT PRIMARY KEY,",
    "  timestamp TEXT NOT NULL,",
    "  session_id TEXT NOT NULL,",
    "  skill_name TEXT NOT NULL,",
    "  skill_args TEXT,",
    "  source TEXT NOT NULL,",
    "  trigger_message TEXT,",
    "  injected_tokens INTEGER,",
    "  cwd TEXT,",
    "  git_branch TEXT,",
    "  recorded_via TEXT,",
    "  tags TEXT,",
    "  outcome TEXT,",
    "  duration_ms INTEGER",
    ");",
    "BEGIN TRANSACTION;",
  ];
  for (const e of events) {
    lines.push(
      "INSERT OR REPLACE INTO skill_events VALUES (" +
        [
          e.id,
          e.timestamp,
          e.sessionId,
          e.skillName,
          e.skillArgs,
          e.source,
          e.triggerMessage,
          e.injectedTokens,
          e.cwd,
          e.gitBranch,
          e.recordedVia,
          e.tags,
          e.outcome,
          e.durationMs,
        ]
          .map(q)
          .join(", ") +
        ");"
    );
  }
  lines.push("COMMIT;");
  return `${lines.join("\n")}\n`;
}

/** Refuse to silently clobber an existing file (#137). */
async function guardOverwrite(path: string, force: boolean): Promise<void> {
  try {
    await access(path);
  } catch {
    return; // does not exist — fine
  }
  if (await confirm(`${path} exists. Overwrite?`, force)) return;
  fail(`Refusing to overwrite ${path}. Pass --force to overwrite in scripts.`);
}

// ─── Commands ────────────────────────────────────────────────────────────────

export function registerExportCommands(program: Command): void {
  // ── export ─────────────────────────────────────────────────────────────
  const exp = program
    .command("export")
    .description("Export captured events as JSON, CSV (RFC 4180) or SQL");
  addFilterOptions(exp)
    .option("--format <fmt>", "Output format: json | csv | sql", "json")
    .option("-o, --output <path>", "Output file path (default: stdout)")
    .option("--limit <n>", "Export at most the N most recent events (#191)", parseLimitOpt)
    .option("--merge <dirs...>", "Merge events from additional store directories (#132)")
    .option("--no-bom", "Omit the UTF-8 BOM from CSV output (#193)")
    .option("-f, --force", "Overwrite the output file without asking (#137)")
    .option("--scan", "Scan session logs first")
    .action(async (opts) => {
      const filter = filterFromOpts(opts);
      if (opts.scan) {
        const { fresh } = await scanAndMerge({ since: filter.since, sessionId: filter.sessionId });
        process.stderr.write(chalk.gray(`  Imported ${fresh.length} new invocations.\n\n`));
      }

      let events: SkillInvocationEvent[];
      if (opts.merge && opts.merge.length > 0) {
        const { getStoreDir } = await import("../../core/config.js");
        const merged = await mergeStores([getStoreDir(), ...opts.merge]);
        events = applyFilter(merged, filter);
      } else {
        events = await readEvents(filter);
      }
      if (opts.limit) events = events.slice(-parseInt(String(opts.limit), 10));

      const fmt = String(opts.format).toLowerCase();
      let out: string;
      if (fmt === "csv") out = toCsv(events, opts.bom !== false);
      else if (fmt === "sql" || fmt === "sqlite") out = toSql(events);
      else if (fmt === "json") out = JSON.stringify(events, null, 2);
      else return fail(`Unknown format: "${opts.format}". Use json, csv or sql.`);

      if (opts.output) {
        await guardOverwrite(String(opts.output), Boolean(opts.force));
        await writeFile(String(opts.output), out, "utf-8");
        console.error(chalk.green(`✓  Exported ${events.length} events → ${opts.output}`));
      } else {
        process.stdout.write(fmt === "json" ? `${out}\n` : out);
      }
    });

  // ── report ─────────────────────────────────────────────────────────────
  const report = program
    .command("report")
    .description("Generate an interactive HTML report and open in browser");
  addFilterOptions(report)
    .option("-o, --output <path>", "Output path", join(homedir(), ".cc-skill-trace", "report.html"))
    .option("--no-open", "Don't open browser")
    .option("--limit <n>", "Include at most the N most recent events (#191)", parseLimitOpt)
    .option("--theme <theme>", "Report theme: dark | light | auto (#150)", "auto")
    .option("--redact", "Mask trigger messages in the report (#108)")
    .option("--share", "After generating, upload as a secret GitHub Gist via gh CLI (#157)")
    .option("--scan", "Scan session logs first")
    .action(async (opts) => {
      const filter = filterFromOpts(opts);
      const theme = String(opts.theme).toLowerCase();
      if (!["dark", "light", "auto"].includes(theme)) {
        fail(`Invalid --theme "${opts.theme}". Use dark, light or auto.`);
      }
      if (opts.scan) {
        const { events: scanned, fresh } = await scanAndMerge({
          since: filter.since,
          sessionId: filter.sessionId,
        });
        console.log(chalk.gray(`  Scanned: ${scanned.length} invocations (${fresh.length} new).`));
      }
      const config = await getConfig();
      const events = await readEvents({
        ...filter,
        limit: opts.limit ? parseInt(String(opts.limit), 10) : undefined,
      });

      const html = buildHtmlReport(events, {
        theme: theme as "dark" | "light" | "auto",
        redactTriggers: Boolean(opts.redact) || config.redactTriggerMessages,
      });
      await writeFile(opts.output, html, "utf-8");
      console.log(chalk.green(`✓  Report → ${opts.output}  (${events.length} events)`));

      if (opts.share) {
        try {
          const url = execFileSync(
            "gh",
            ["gist", "create", opts.output, "--desc", "cc-skill-trace report"],
            {
              stdio: ["ignore", "pipe", "pipe"],
            }
          )
            .toString()
            .trim();
          console.log(chalk.green(`✓  Shared as secret gist → ${url}`));
        } catch {
          console.log(
            chalk.yellow("⚠  Could not create gist. Install GitHub CLI (gh) and run: gh auth login")
          );
        }
      }

      if (opts.open !== false) {
        if (!openInBrowser(opts.output)) {
          console.log(chalk.gray(`  Open manually: ${opts.output}`));
        }
      }
    });

  // ── clear ──────────────────────────────────────────────────────────────
  program
    .command("clear")
    .description("Clear all captured events")
    .option("--older-than <duration>", "Remove events older than this (e.g. 12h, 30d, 4w, 2mo)")
    .option("-f, --force", "Skip the confirmation prompt (#68)")
    .action(async (opts) => {
      if (opts.olderThan) {
        let cutoff: Date;
        try {
          cutoff = parseDuration(String(opts.olderThan));
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
        const { removed, kept } = await pruneEvents(cutoff.toISOString());
        console.log(
          chalk.green(`✓  Removed ${removed} events older than ${opts.olderThan} (${kept} kept).`)
        );
        return;
      }
      if (!(await confirm("Delete ALL captured events? This cannot be undone.", opts.force))) {
        console.log(chalk.gray("  Aborted. (Use --force to skip this prompt in scripts.)"));
        return;
      }
      await clearEvents();
      console.log(chalk.green("✓  Cleared."));
    });

  // ── prune (#80) ────────────────────────────────────────────────────────
  program
    .command("prune")
    .description(
      "Remove events older than a duration (standalone alias of clear --older-than) (#80)"
    )
    .requiredOption("--older-than <duration>", "Duration threshold (e.g. 12h, 30d, 4w, 2mo)")
    .option("--dry-run", "Report what would be removed without writing")
    .action(async (opts) => {
      let cutoff: Date;
      try {
        cutoff = parseDuration(String(opts.olderThan));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
      const iso = cutoff.toISOString();
      if (opts.dryRun) {
        const events = await readEvents({});
        const removable = events.filter((e) => e.timestamp < iso).length;
        console.log(
          chalk.yellow(
            `  [dry-run] Would remove ${removable} of ${events.length} events older than ${opts.olderThan}.`
          )
        );
        return;
      }
      const { removed, kept } = await pruneEvents(iso);
      console.log(
        chalk.green(`✓  Removed ${removed} events older than ${opts.olderThan} (${kept} kept).`)
      );
    });

  // ── tag (#127) ─────────────────────────────────────────────────────────
  program
    .command("tag <eventId>")
    .description("Add or remove labels on an event, e.g. mark a false positive (#127)")
    .option("--add <tags...>", "Tags to add")
    .option("--remove <tags...>", "Tags to remove")
    .option("--false-positive", "Shortcut for --add false-positive")
    .action(async (eventId: string, opts) => {
      const add: string[] = [
        ...(opts.add ?? []),
        ...(opts.falsePositive ? ["false-positive"] : []),
      ];
      const remove: string[] = opts.remove ?? [];
      if (add.length === 0 && remove.length === 0) {
        fail("Nothing to do — pass --add <tag>, --remove <tag> or --false-positive.");
      }
      const found = await updateEvent(eventId, (ev) => {
        const tags = new Set(ev.tags ?? []);
        for (const t of add) tags.add(t);
        for (const t of remove) tags.delete(t);
        const next = { ...ev, tags: [...tags] };
        if (next.tags.length === 0) delete (next as Partial<SkillInvocationEvent>).tags;
        return next;
      });
      if (!found)
        fail(`Event not found: ${eventId} (IDs are shown in: cc-skill-trace show --json)`);
      console.log(chalk.green(`✓  Updated tags on ${eventId}`));
    });
}
