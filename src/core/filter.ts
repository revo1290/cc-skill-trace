import type { InvocationSource, ProviderId, SkillInvocationEvent } from "./types.js";

/**
 * Declarative event filter, shared by every CLI command and the public API (#119).
 * All fields are optional and AND-combined.
 */
export interface EventFilter {
  /** Only events with `timestamp >= since` (ISO string). */
  since?: string;
  /** Only events with `timestamp <= before` (ISO string). */
  before?: string;
  /** Exact skill name match. */
  skill?: string;
  /** Exact session ID match. */
  sessionId?: string;
  /** Invocation source: "user" | "claude" (#149). */
  source?: InvocationSource;
  /** Working-directory filter — matches events whose cwd starts with this path (#192). */
  cwd?: string;
  /** Git branch exact match (#99). */
  branch?: string;
  /** Case-insensitive regex tested against triggerMessage, skillArgs and skillName (#43). */
  grep?: string;
  /** Only events carrying this tag (#127). */
  tag?: string;
  /** Which agent CLI produced the event (#v3-multi-provider). A missing `event.provider` counts as "claude-code". */
  provider?: ProviderId;
}

/** An EventFilter with its regex pre-compiled, ready for per-event matching. */
export interface CompiledEventFilter extends EventFilter {
  grepRe?: RegExp;
}

/**
 * Pre-compile an EventFilter (validates the `grep` regex once).
 * @throws {Error} when `grep` is not a valid regular expression.
 */
export function compileFilter(filter: EventFilter): CompiledEventFilter {
  const compiled: CompiledEventFilter = { ...filter };
  if (filter.grep) {
    try {
      compiled.grepRe = new RegExp(filter.grep, "i");
    } catch {
      throw new Error(`Invalid --grep pattern: ${filter.grep}`);
    }
  }
  return compiled;
}

/** Test one event against a compiled filter. */
export function matchesFilter(ev: SkillInvocationEvent, f: CompiledEventFilter): boolean {
  if (f.since && ev.timestamp < f.since) return false;
  if (f.before && ev.timestamp > f.before) return false;
  if (f.skill && ev.skillName !== f.skill) return false;
  if (f.sessionId && ev.sessionId !== f.sessionId) return false;
  if (f.source && ev.source !== f.source) return false;
  if (f.cwd && !(ev.cwd ?? "").startsWith(f.cwd)) return false;
  if (f.branch && ev.gitBranch !== f.branch) return false;
  if (f.tag && !(ev.tags ?? []).includes(f.tag)) return false;
  if (f.provider && (ev.provider ?? "claude-code") !== f.provider) return false;
  if (f.grepRe) {
    const haystack = `${ev.skillName}\n${ev.skillArgs ?? ""}\n${ev.triggerMessage ?? ""}`;
    if (!f.grepRe.test(haystack)) return false;
  }
  return true;
}

/** Filter an in-memory event array (convenience wrapper around matchesFilter). */
export function applyFilter(
  events: SkillInvocationEvent[],
  filter: EventFilter
): SkillInvocationEvent[] {
  const compiled = compileFilter(filter);
  return events.filter((ev) => matchesFilter(ev, compiled));
}

// ─── Date / duration parsing ─────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]*)?$/;
// "min" is spelled out (not "m") to avoid clashing with the months unit (#93, #199).
const DURATION_RE =
  /^(\d+)\s*(min|mins|minutes?|h|hr|hours?|d|days?|w|weeks?|mo|m|months?|y|years?)$/i;

/**
 * Subtract a human duration from `now` (#93, #118, #199).
 * Supported units: `min` minutes, `h` hours, `d` days, `w` weeks, `m`/`mo` months, `y` years.
 * @throws {Error} on unrecognized input.
 */
export function parseDuration(value: string, now = new Date()): Date {
  const match = DURATION_RE.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration: "${value}". Expected e.g. 30min, 12h, 30d, 4w, 2mo, 1y`);
  }
  // biome-ignore lint/style/noNonNullAssertion: group 1 (`\d+`) is mandatory in DURATION_RE, so it's always captured once `match` itself is non-null.
  const n = parseInt(match[1]!, 10);
  const unit = match[2]?.toLowerCase();
  const cutoff = new Date(now.getTime());
  if (unit.startsWith("min")) cutoff.setMinutes(cutoff.getMinutes() - n);
  else if (unit.startsWith("h")) cutoff.setHours(cutoff.getHours() - n);
  else if (unit.startsWith("d")) cutoff.setDate(cutoff.getDate() - n);
  else if (unit.startsWith("w")) cutoff.setDate(cutoff.getDate() - n * 7);
  else if (unit === "m" || unit === "mo" || unit.startsWith("month"))
    cutoff.setMonth(cutoff.getMonth() - n);
  else cutoff.setFullYear(cutoff.getFullYear() - n);
  return cutoff;
}

/**
 * Resolve a human-friendly date expression to an ISO timestamp (#159).
 *
 * Accepts, case-insensitively:
 * - ISO dates/timestamps: `2026-04-01`, `2026-04-01T12:00:00Z` (passed through)
 * - `today`, `yesterday`
 * - `last week`, `last month`
 * - `N days ago`, `3 weeks ago`, `2 months ago`, `12 hours ago`
 * - bare durations meaning "this long ago": `7d`, `24h`, `2w`, `1mo`
 *
 * @throws {Error} on unrecognized input.
 */
export function resolveDateInput(input: string, now = new Date()): string {
  const raw = input.trim();
  if (ISO_DATE_RE.test(raw)) {
    if (Number.isNaN(Date.parse(raw))) throw new Error(`Invalid date: "${input}"`);
    return raw;
  }

  const lower = raw.toLowerCase();
  const startOfDay = (d: Date): string => {
    const copy = new Date(d.getTime());
    copy.setHours(0, 0, 0, 0);
    return copy.toISOString();
  };

  if (lower === "now") return now.toISOString();
  if (lower === "today") return startOfDay(now);
  if (lower === "yesterday") {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - 1);
    return startOfDay(d);
  }
  if (lower === "last week") return parseDuration("1w", now).toISOString();
  if (lower === "last month") return parseDuration("1mo", now).toISOString();

  const ago = /^(\d+)\s+(hour|day|week|month|year)s?\s+ago$/.exec(lower);
  if (ago) {
    const unitMap: Record<string, string> = {
      hour: "h",
      day: "d",
      week: "w",
      month: "mo",
      year: "y",
    };
    // biome-ignore lint/style/noNonNullAssertion: group 2 is a mandatory alternation covering exactly unitMap's keys, so it's always captured and always found.
    return parseDuration(`${ago[1]}${unitMap[ago[2]!]}`, now).toISOString();
  }

  // Bare duration = "this long ago"
  return parseDuration(raw, now).toISOString();
}
