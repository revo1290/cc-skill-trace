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

export function clearEvents(dir = STORE_DIR): Promise<void> {
  return enqueueWrite(dir, async () => {
    await ensureStoreDir(dir);
    await writeFile(join(dir, "events.jsonl"), "", "utf-8");
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
