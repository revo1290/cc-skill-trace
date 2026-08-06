import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { getStoreDir } from "./config.js";
import { compileFilter, matchesFilter } from "./filter.js";
import type { EventFilter } from "./filter.js";
import { EVENT_SCHEMA_VERSION } from "./types.js";
import type { SkillInvocationEvent } from "./types.js";

export { getStoreDir } from "./config.js";

/** Default store directory. Prefer {@link getStoreDir}, which honors CC_STORE_DIR (#95). */
export const STORE_DIR = join(homedir(), ".cc-skill-trace");
/** Default events file path (informational). */
export const EVENTS_FILE = join(STORE_DIR, "events.jsonl");

const EVENTS_FILE_NAME = "events.jsonl";

function eventsPath(dir: string): string {
  return join(dir, EVENTS_FILE_NAME);
}

/** Create the store directory if it does not exist. */
export async function ensureStoreDir(dir = getStoreDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// ─── Write serialization queue ───────────────────────────────────────────────
// Multiple concurrent operations within one process can race on the same
// events.jsonl. We serialize all mutating operations (append, clear, prune,
// update) per store dir using a per-dir promise chain so writes never
// interleave. Cross-process safety additionally relies on each append being a
// single small write (well under PIPE_BUF), which POSIX guarantees is atomic
// even with O_APPEND from multiple processes (#161).

const writeQueues = new Map<string, Promise<void>>();

function enqueueWrite<T = void>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(dir) ?? Promise.resolve();
  const next = prev.then(
    () => fn(),
    () => fn()
  );
  // Store a void chain so the queue type stays consistent
  const tail = next.then(
    () => {},
    () => {}
  );
  writeQueues.set(dir, tail);
  // Release the Map entry once this write settles, but only if no newer write
  // has been enqueued in the meantime (i.e. `tail` is still the current tail).
  // Otherwise entries grow unbounded — one per distinct dir kept alive for the
  // whole process lifetime (#169: --follow, programmatic API, many-dir tests).
  void tail.finally(() => {
    if (writeQueues.get(dir) === tail) {
      writeQueues.delete(dir);
    }
  });
  return next;
}

/**
 * Number of store directories with an in-flight (or not-yet-released) write
 * queue. Intended for tests/diagnostics — a healthy idle store settles to 0.
 */
export function pendingWriteQueueCount(): number {
  return writeQueues.size;
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 25): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

// ─── Read options ────────────────────────────────────────────────────────────

/** Options accepted by {@link readEvents}. Extends {@link EventFilter} (#119). */
export interface ReadEventsOptions extends EventFilter {
  /** Store directory (defaults to {@link getStoreDir}). */
  dir?: string;
  /**
   * Return at most this many events, taken from the most recent end (#18).
   * Avoids loading unbounded datasets into memory for dashboards/exports.
   */
  limit?: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append one event to the store.
 * Writes are serialized per directory and retried up to 3 times (#124).
 * Events are stamped with the current schema version (#94).
 */
export function appendEvent(event: SkillInvocationEvent, dir = getStoreDir()): Promise<void> {
  return enqueueWrite(dir, () =>
    withRetry(async () => {
      await ensureStoreDir(dir);
      const stamped: SkillInvocationEvent = { v: EVENT_SCHEMA_VERSION, ...event };
      // A single small append with O_APPEND is atomic in practice on local
      // filesystems, which keeps concurrent hook processes from interleaving (#161).
      await appendFile(eventsPath(dir), `${JSON.stringify(stamped)}\n`, "utf-8");
    })
  );
}

/**
 * Read events from the store as a stream, applying filters per line so the
 * whole file is never held in memory (#89, #119).
 *
 * Accepts either a legacy `readEvents(dirString)` call or the options form.
 */
export async function readEvents(
  opts: ReadEventsOptions | string = {}
): Promise<SkillInvocationEvent[]> {
  // Legacy: readEvents(dirString)
  const options: ReadEventsOptions = typeof opts === "string" ? { dir: opts } : opts;
  const dir = options.dir ?? getStoreDir();
  const compiled = compileFilter(options);

  const events: SkillInvocationEvent[] = [];
  let rl: ReturnType<typeof createInterface>;
  try {
    await stat(eventsPath(dir));
    rl = createInterface({
      input: createReadStream(eventsPath(dir), { encoding: "utf-8" }),
      crlfDelay: Infinity,
    });
  } catch {
    return [];
  }

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line) as SkillInvocationEvent;
        if (!matchesFilter(ev, compiled)) continue;
        events.push(ev);
        // Soft cap: keep at most 2×limit in memory, trimming from the old end.
        if (options.limit != null && events.length > options.limit * 2) {
          events.splice(0, events.length - options.limit);
        }
      } catch {
        // skip malformed lines without losing the rest
      }
    }
  } catch {
    // stream error mid-read (e.g. file removed) — return what we have
  }

  if (options.limit != null && events.length > options.limit) {
    return events.slice(-options.limit);
  }
  return events;
}

/**
 * Read the most recently appended event, if any.
 * Reads only the tail of the file — used by the hook's dedup window (#70).
 */
export async function readLastEvent(
  dir = getStoreDir()
): Promise<SkillInvocationEvent | undefined> {
  const path = eventsPath(dir);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return undefined;
  }
  const TAIL = 8 * 1024;
  const start = Math.max(0, size - TAIL);
  const chunks: Buffer[] = [];
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(path, { start })
      .on("data", (c) => chunks.push(Buffer.from(c)))
      .on("end", () => resolvePromise())
      .on("error", reject);
  }).catch(() => {});
  const lines = Buffer.concat(chunks)
    .toString("utf-8")
    .split("\n")
    .filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      // biome-ignore lint/style/noNonNullAssertion: i is bounded by lines.length above.
      return JSON.parse(lines[i]!) as SkillInvocationEvent;
    } catch {
      // tail may begin mid-line; keep walking backwards
    }
  }
  return undefined;
}

// ─── Cross-source deduplication (#182) ───────────────────────────────────────
// `hook-capture` assigns each event a random UUID, while `scan` uses the Skill
// `tool_use` id (e.g. "toolu_abc123") from the session log. The same invocation
// therefore gets two different ids, so id-based dedup never matches and `scan`
// stores a second copy of every hook-captured event. We treat a scanned event
// and a stored event as the *same* invocation when they share session, skill
// name and args and their timestamps fall within this window — the PreToolUse
// hook fires within about a second of the assistant message whose timestamp
// `scan` reads, so the window only needs to absorb that small skew (and must
// stay short enough not to merge two deliberate re-runs of the same skill).
export const DEDUP_WINDOW_MS = 5000;

function sameInvocation(a: SkillInvocationEvent, b: SkillInvocationEvent): boolean {
  if (a.sessionId !== b.sessionId) return false;
  if (a.skillName !== b.skillName) return false;
  if ((a.skillArgs ?? "") !== (b.skillArgs ?? "")) return false;
  if ((a.provider ?? "claude-code") !== (b.provider ?? "claude-code")) return false;
  const dt = Math.abs(Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return Number.isFinite(dt) && dt <= DEDUP_WINDOW_MS;
}

/**
 * From freshly scanned `candidates`, return only the events not already present
 * in `existing`. A candidate is dropped when its id already exists (repeated
 * scans) or when it matches an existing event by session, skill, args and
 * timestamp window — which is how a scan result lines up with the
 * hook-captured record of the same invocation (#182). Candidates are only
 * compared against `existing`, never against each other, so distinct scanned
 * invocations (each with its own `tool_use` id) are always preserved.
 */
export function selectNewEvents(
  existing: SkillInvocationEvent[],
  candidates: SkillInvocationEvent[]
): SkillInvocationEvent[] {
  const existingIds = new Set(existing.map((e) => e.id));
  const fresh: SkillInvocationEvent[] = [];
  for (const ev of candidates) {
    if (existingIds.has(ev.id)) continue;
    if (existing.some((e) => sameInvocation(e, ev))) continue;
    fresh.push(ev);
  }
  return fresh;
}

// ─── Enriching hook-captured events from scan (#223) ─────────────────────────
// A candidate dropped by `selectNewEvents` (because it matches an existing
// event by id or by `sameInvocation`) isn't necessarily redundant: scan reads
// the full session log, so it can carry a `triggerMessage` the hook-captured
// event was never able to record (the PreToolUse payload has no preceding
// message text), and — for providers like Codex — a more confident `source`
// determination (e.g. an explicit `$SkillName` mention) than the hook could
// make on its own. `enrichExistingEvents` finds those matches and reports
// only the fields that should be backfilled onto the *existing* stored event,
// leaving every other field (id, timestamp, sessionId, skillArgs, provider,
// recordedVia, outcome, durationMs, tags, ...) untouched.

/** A backfill patch for one already-stored event, computed by {@link enrichExistingEvents}. */
export interface EventEnrichment {
  /** ID of the existing stored event to patch (via {@link updateEvent}). */
  id: string;
  /** Only ever contains `triggerMessage` and/or `source` — additive fields only. */
  patch: Partial<Pick<SkillInvocationEvent, "triggerMessage" | "source">>;
}

/**
 * From freshly scanned `candidates`, compute enrichment patches for matching
 * `existing` events (#223). A candidate "matches" an existing event the same
 * way `selectNewEvents` decides to drop it: same id, or {@link sameInvocation}.
 *
 * Only two fields are ever backfilled, and only when they add information:
 *  - `triggerMessage`: copied over when the existing event is missing one and
 *    the candidate has one.
 *  - `source`: upgraded from `"claude"` to `"user"` when the candidate found
 *    stronger evidence of an explicit invocation. Never downgraded the other
 *    way — enrichment only ever adds information, never removes it.
 *
 * Existing events with nothing to add are omitted from the result, so callers
 * can skip a no-op `updateEvent` write.
 */
export function enrichExistingEvents(
  existing: SkillInvocationEvent[],
  candidates: SkillInvocationEvent[]
): EventEnrichment[] {
  const enrichments: EventEnrichment[] = [];
  for (const candidate of candidates) {
    const match = existing.find((e) => e.id === candidate.id || sameInvocation(e, candidate));
    if (!match) continue;

    const patch: EventEnrichment["patch"] = {};
    if (match.triggerMessage == null && candidate.triggerMessage != null) {
      patch.triggerMessage = candidate.triggerMessage;
    }
    if (match.source === "claude" && candidate.source === "user") {
      patch.source = "user";
    }
    if (Object.keys(patch).length > 0) {
      enrichments.push({ id: match.id, patch });
    }
  }
  return enrichments;
}

/** Delete all events (truncates the file). */
export function clearEvents(dir = getStoreDir()): Promise<void> {
  return enqueueWrite(dir, async () => {
    await ensureStoreDir(dir);
    await writeFile(eventsPath(dir), "", "utf-8");
  });
}

export interface BackupResult {
  /** Absolute path of the newly written backup, or null if there was nothing to back up. */
  backupPath: string | null;
  /** If a previous backup already existed, the path it was rotated to; otherwise null. */
  rotatedTo: string | null;
}

/**
 * Copy `events.jsonl` to `events.jsonl.bak` so a destructive operation (e.g.
 * `scan --clear`) can be recovered if it fails midway (#180). If a backup
 * already exists it is rotated to `events.jsonl.bak.bak` rather than silently
 * overwritten. Returns `{ backupPath: null }` when there is nothing to back up.
 */
export function backupEvents(dir = getStoreDir()): Promise<BackupResult> {
  return enqueueWrite(dir, async () => {
    const path = eventsPath(dir);
    const bakPath = join(dir, "events.jsonl.bak");
    const bakBakPath = join(dir, "events.jsonl.bak.bak");

    let content: string;
    try {
      content = await readFile(path, "utf-8");
    } catch {
      // No store file yet — nothing to back up.
      return { backupPath: null, rotatedTo: null };
    }

    await ensureStoreDir(dir);

    // Preserve an existing backup instead of overwriting it.
    let rotatedTo: string | null = null;
    try {
      const prev = await readFile(bakPath, "utf-8");
      await writeFile(bakBakPath, prev, "utf-8");
      rotatedTo = bakBakPath;
    } catch {
      // No existing backup to rotate.
    }

    await writeFile(bakPath, content, "utf-8");
    return { backupPath: bakPath, rotatedTo };
  });
}

/** Remove events whose timestamp is older than `beforeIso` (ISO string).
 *  Returns counts of removed and kept events. */
export function pruneEvents(
  beforeIso: string,
  dir = getStoreDir()
): Promise<{ removed: number; kept: number }> {
  return enqueueWrite(dir, async () => {
    await ensureStoreDir(dir);
    const events = await readEvents({ dir });
    const kept = events.filter((e) => e.timestamp >= beforeIso);
    const removed = events.length - kept.length;
    const content = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : "");
    await writeFile(eventsPath(dir), content, "utf-8");
    return { removed, kept: kept.length };
  });
}

/**
 * Apply a patch to the single event with the given ID (#127, #144).
 * Rewrites the file atomically. Returns true when the event was found.
 */
export function updateEvent(
  id: string,
  patch: Partial<SkillInvocationEvent> | ((ev: SkillInvocationEvent) => SkillInvocationEvent),
  dir = getStoreDir()
): Promise<boolean> {
  return enqueueWrite(dir, async () => {
    const events = await readEvents({ dir });
    let found = false;
    const next = events.map((ev) => {
      if (ev.id !== id) return ev;
      found = true;
      return typeof patch === "function" ? patch(ev) : { ...ev, ...patch };
    });
    if (!found) return false;
    const path = eventsPath(dir);
    const tmp = `${path}.tmp`;
    await writeFile(
      tmp,
      next.map((e) => JSON.stringify(e)).join("\n") + (next.length ? "\n" : ""),
      "utf-8"
    );
    await rename(tmp, path);
    return true;
  });
}

/**
 * Dedupe events by ID (first occurrence across `sources`, in order, wins) and
 * sort the result by timestamp. Shared core of {@link mergeStores} (store
 * directories) and {@link mergeEventSources} (arbitrary files, #226) so both
 * stay consistent instead of reimplementing the same dedup rule twice.
 */
function dedupeAndSort(sources: SkillInvocationEvent[][]): {
  events: SkillInvocationEvent[];
  duplicates: number;
} {
  const seen = new Set<string>();
  const events: SkillInvocationEvent[] = [];
  let duplicates = 0;
  for (const list of sources) {
    for (const ev of list) {
      if (seen.has(ev.id)) {
        duplicates++;
        continue;
      }
      seen.add(ev.id);
      events.push(ev);
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { events, duplicates };
}

/**
 * Merge events from multiple store directories, de-duplicated by event ID and
 * sorted by timestamp (#132). The first occurrence of an ID wins.
 */
export async function mergeStores(dirs: string[]): Promise<SkillInvocationEvent[]> {
  const sources: SkillInvocationEvent[][] = [];
  for (const dir of dirs) sources.push(await readEvents({ dir }));
  return dedupeAndSort(sources).events;
}

// ─── Cross-file merge for the `merge` CLI command (#226) ─────────────────────
// mergeStores() above expects store *directories* (each containing
// events.jsonl) — the shape used internally and by `export --merge`. The
// `merge` command instead targets ad hoc files people hand around (a raw
// events.jsonl copied off another machine, or an `export --format json`
// array), so it gets its own reader that sniffs the file shape.

/**
 * Read events from a single `merge` source (#226): a store *directory*
 * (containing events.jsonl, read the same way as {@link mergeStores}), a raw
 * `events.jsonl`-style file (one JSON event per line), or a JSON array file
 * as written by `export --format json`. Malformed lines/entries are skipped
 * rather than aborting the whole source. Throws a plain `Error` with a
 * user-facing message when `path` does not exist or cannot be read.
 */
export async function readEventSource(path: string): Promise<SkillInvocationEvent[]> {
  let isDir: boolean;
  try {
    isDir = (await stat(path)).isDirectory();
  } catch {
    throw new Error(`Source not found or not readable: ${path}`);
  }
  if (isDir) return readEvents({ dir: path });

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Could not read source ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const trimmed = raw.trim();
  if (!trimmed) return [];

  // JSON array, e.g. `export --format json` output.
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter(isValidEvent);
    } catch {
      // Not actually a JSON array — fall through to line-delimited parsing.
    }
  }

  // JSONL: one JSON event per line (the raw events.jsonl format).
  const events: SkillInvocationEvent[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsedLine: unknown = JSON.parse(line);
      if (isValidEvent(parsedLine)) events.push(parsedLine);
    } catch {
      // skip malformed lines without losing the rest of the source
    }
  }
  return events;
}

/**
 * Merge events from multiple arbitrary `merge` sources (#226): directories or
 * export files, in any combination. Reuses the same dedup-by-ID +
 * sort-by-timestamp rule as {@link mergeStores} via {@link dedupeAndSort}.
 */
export async function mergeEventSources(
  paths: string[]
): Promise<{ events: SkillInvocationEvent[]; duplicates: number }> {
  const sources: SkillInvocationEvent[][] = [];
  for (const path of paths) sources.push(await readEventSource(path));
  return dedupeAndSort(sources);
}

// ─── Store integrity (#175) ──────────────────────────────────────────────────

/** Result of {@link checkStore}. */
export interface StoreCheckResult {
  /** Total non-empty lines in events.jsonl. */
  totalLines: number;
  /** Lines that parsed as valid events. */
  validEvents: number;
  /** 1-based line numbers that failed to parse or lacked required fields. */
  corruptLines: number[];
  /** Event IDs that appear more than once. */
  duplicateIds: string[];
}

function isValidEvent(value: unknown): value is SkillInvocationEvent {
  if (!value || typeof value !== "object") return false;
  const ev = value as Record<string, unknown>;
  return (
    typeof ev.id === "string" &&
    typeof ev.timestamp === "string" &&
    typeof ev.sessionId === "string" &&
    typeof ev.skillName === "string" &&
    typeof ev.source === "string"
  );
}

/** Scan events.jsonl for malformed lines and duplicate IDs without modifying it (#175). */
export async function checkStore(dir = getStoreDir()): Promise<StoreCheckResult> {
  const result: StoreCheckResult = {
    totalLines: 0,
    validEvents: 0,
    corruptLines: [],
    duplicateIds: [],
  };
  let raw: string;
  try {
    raw = await readFile(eventsPath(dir), "utf-8");
  } catch {
    return result;
  }
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: i is bounded by lines.length above.
    const line = lines[i]!;
    if (!line.trim()) continue;
    result.totalLines++;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isValidEvent(parsed)) {
        result.corruptLines.push(i + 1);
        continue;
      }
      result.validEvents++;
      if (seen.has(parsed.id)) dupes.add(parsed.id);
      seen.add(parsed.id);
    } catch {
      result.corruptLines.push(i + 1);
    }
  }
  result.duplicateIds = [...dupes];
  return result;
}

/**
 * Rewrite events.jsonl keeping only valid, first-occurrence events (#175).
 * The original file is backed up as `events.jsonl.bak` first.
 */
export function repairStore(
  dir = getStoreDir()
): Promise<{ kept: number; droppedCorrupt: number; droppedDuplicates: number }> {
  return enqueueWrite(dir, async () => {
    const path = eventsPath(dir);
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch {
      return { kept: 0, droppedCorrupt: 0, droppedDuplicates: 0 };
    }
    await copyFile(path, `${path}.bak`);
    const seen = new Set<string>();
    const kept: string[] = [];
    let droppedCorrupt = 0;
    let droppedDuplicates = 0;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isValidEvent(parsed)) {
          droppedCorrupt++;
          continue;
        }
        if (seen.has(parsed.id)) {
          droppedDuplicates++;
          continue;
        }
        seen.add(parsed.id);
        kept.push(JSON.stringify(parsed));
      } catch {
        droppedCorrupt++;
      }
    }
    const tmp = `${path}.tmp`;
    await writeFile(tmp, kept.join("\n") + (kept.length ? "\n" : ""), "utf-8");
    await rename(tmp, path);
    return { kept: kept.length, droppedCorrupt, droppedDuplicates };
  });
}
