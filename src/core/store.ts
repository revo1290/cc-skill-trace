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
  writeQueues.set(
    dir,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
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
