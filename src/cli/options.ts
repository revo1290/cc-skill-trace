import type { Command } from "commander";
import type { EventFilter } from "../core/filter.js";
import { compileFilter, resolveDateInput } from "../core/filter.js";
import type { InvocationSource } from "../core/types.js";
import { fail } from "./ui.js";

/** Commander option parser: human-friendly date → ISO string (#159). */
export function parseDateOpt(value: string): string {
  try {
    return resolveDateInput(value);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Commander option parser: positive integer. */
export function parseLimitOpt(value: string): string {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 1 || String(n) !== value.trim()) {
    fail(`Invalid numeric value: "${value}". Expected a positive integer, e.g. 50`);
  }
  return value;
}

/** Commander option parser: invocation source (#149). */
export function parseSourceOpt(value: string): InvocationSource {
  const v = value.toLowerCase();
  if (v === "user" || v === "claude") return v;
  if (v === "auto") return "claude"; // ergonomic alias
  return fail(`Invalid --source: "${value}". Use "claude" (auto) or "user".`);
}

/** Fail fast if --since is later than --before. */
export function validateDateRange(since: string | undefined, before: string | undefined): void {
  if (since && before && since > before) {
    fail(`--since (${since}) must be earlier than --before (${before})`);
  }
}

/** Attach the standard event-filter flags shared by most commands. */
export function addFilterOptions(cmd: Command): Command {
  return cmd
    .option(
      "--since <date>",
      'From date — ISO or human ("yesterday", "7d", "2 weeks ago")',
      parseDateOpt
    )
    .option("--before <date>", "Up to date — ISO or human", parseDateOpt)
    .option("--skill <name>", "Filter by skill name")
    .option("--session <id>", "Filter by session ID")
    .option("--source <src>", "Filter by source: claude (auto) or user (#149)", parseSourceOpt)
    .option("--cwd <path>", "Filter by working directory prefix (#192)")
    .option("--branch <name>", "Filter by git branch (#99)")
    .option("--grep <regex>", "Regex filter on trigger message / args / skill name (#43)")
    .option("--tag <tag>", "Filter by event tag (#127)");
}

/** Build an EventFilter from parsed commander options (validates ranges and regex). */
export function filterFromOpts(opts: Record<string, unknown>): EventFilter {
  validateDateRange(opts.since as string | undefined, opts.before as string | undefined);
  const filter: EventFilter = {
    since: opts.since as string | undefined,
    before: opts.before as string | undefined,
    skill: opts.skill as string | undefined,
    sessionId: opts.session as string | undefined,
    source: opts.source as InvocationSource | undefined,
    cwd: opts.cwd as string | undefined,
    branch: opts.branch as string | undefined,
    grep: opts.grep as string | undefined,
    tag: opts.tag as string | undefined,
  };
  try {
    compileFilter(filter); // validate the regex once, up front (#43)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  return filter;
}
