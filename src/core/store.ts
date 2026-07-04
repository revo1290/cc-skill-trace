import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInvocationEvent } from "./types.js";

export const STORE_DIR = join(homedir(), ".cc-skill-trace");
export const EVENTS_FILE = join(STORE_DIR, "events.jsonl");

export async function ensureStoreDir(dir = STORE_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// ─── Write serialization queue ───────────────────────────────────────────────
// Multiple concurrent hook invocations can race on the same events.jsonl.
// We serialize all mutating operations (append, clear, prune) per store dir
// using a per-dir promise chain so writes never interleave.

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

// ─── Read options ────────────────────────────────────────────────────────────

export interface ReadEventsOptions {
  /** Store directory (defaults to STORE_DIR) */
  dir?: string;
  /** Only return events with timestamp >= this ISO string */
  since?: string;
  /** Only return events with timestamp <= this ISO string */
  before?: string;
  /** Only return events for this skill name */
  skill?: string;
  /** Only return events for this session ID */
  sessionId?: string;
  /**
   * Return at most this many events, taken from the most recent end (#18).
   * Avoids loading unbounded datasets into memory for dashboards/exports.
   */
  limit?: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function appendEvent(event: SkillInvocationEvent, dir = STORE_DIR): Promise<void> {
  return enqueueWrite(dir, async () => {
    await ensureStoreDir(dir);
    await appendFile(join(dir, "events.jsonl"), JSON.stringify(event) + "\n", "utf-8");
  });
}

/**
 * Read events from the store, optionally applying filters at parse time to
 * avoid loading the entire file into memory (#18).
 *
 * Accepts either a legacy `readEvents(dirString)` call or the new
 * `readEvents(options)` form — both are supported for backward compatibility.
 */
export async function readEvents(
  opts: ReadEventsOptions | string = {}
): Promise<SkillInvocationEvent[]> {
  // Legacy: readEvents(dirString)
  const options: ReadEventsOptions = typeof opts === "string" ? { dir: opts } : opts;
  const dir = options.dir ?? STORE_DIR;

  let raw: string;
  try {
    raw = await readFile(join(dir, "events.jsonl"), "utf-8");
  } catch {
    return [];
  }

  const events: SkillInvocationEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as SkillInvocationEvent;
      // Apply filters at parse time — avoids accumulating excluded events in memory
      if (options.since && ev.timestamp < options.since) continue;
      if (options.before && ev.timestamp > options.before) continue;
      if (options.skill && ev.skillName !== options.skill) continue;
      if (options.sessionId && ev.sessionId !== options.sessionId) continue;
      events.push(ev);
    } catch {
      // skip malformed lines without losing the rest
    }
  }

  // Apply limit: keep only the most recent N events
  if (options.limit != null && events.length > options.limit) {
    return events.slice(-options.limit);
  }
  return events;
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

export function clearEvents(dir = STORE_DIR): Promise<void> {
  return enqueueWrite(dir, async () => {
    await ensureStoreDir(dir);
    await writeFile(join(dir, "events.jsonl"), "", "utf-8");
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
export function backupEvents(dir = STORE_DIR): Promise<BackupResult> {
  return enqueueWrite(dir, async () => {
    const eventsPath = join(dir, "events.jsonl");
    const bakPath = join(dir, "events.jsonl.bak");
    const bakBakPath = join(dir, "events.jsonl.bak.bak");

    let content: string;
    try {
      content = await readFile(eventsPath, "utf-8");
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
  dir = STORE_DIR
): Promise<{ removed: number; kept: number }> {
  return enqueueWrite(dir, async () => {
    await ensureStoreDir(dir);
    const events = await readEvents(dir);
    const kept = events.filter((e) => e.timestamp >= beforeIso);
    const removed = events.length - kept.length;
    const content = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : "");
    await writeFile(join(dir, "events.jsonl"), content, "utf-8");
    return { removed, kept: kept.length };
  });
}
