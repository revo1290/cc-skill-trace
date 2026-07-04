import { access, appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

// ─── Integrity: check & repair (#175) ─────────────────────────────────────────
// A crash mid-write can leave a truncated event at the tail of events.jsonl, and
// an interrupted prune/clear can leave a stray `events.jsonl.tmp`. `readEvents`
// silently skips unparseable lines (correct, but invisible to the user), so
// `doctor` surfaces and repairs these conditions.

export interface StoreIntegrity {
  /** Absolute path of the inspected store file. */
  storePath: string;
  /** Non-empty lines in the file. */
  totalLines: number;
  /** Lines that parse as JSON. */
  validEvents: number;
  /** Lines that fail to parse but look structurally complete (end with `}`). */
  malformedLines: number;
  /** Lines that fail to parse and appear cut off mid-write (no closing `}`). */
  truncatedLines: number;
  /** Path to a stray `events.jsonl.tmp` left by an interrupted write, else null. */
  tmpLeftover: string | null;
}

/** Path of a leftover temp file from an interrupted prune/clear, or null. */
async function findTmpLeftover(dir: string): Promise<string | null> {
  const tmpPath = join(dir, "events.jsonl.tmp");
  try {
    await access(tmpPath);
    return tmpPath;
  } catch {
    return null;
  }
}

/**
 * Inspect the event store without modifying it. Reports how many lines are
 * valid, malformed, or truncated, and whether a stray temp file is present.
 */
export async function checkStoreIntegrity(dir = STORE_DIR): Promise<StoreIntegrity> {
  const storePath = join(dir, "events.jsonl");

  let raw = "";
  try {
    raw = await readFile(storePath, "utf-8");
  } catch {
    // No store file yet — treated as an empty store.
  }

  let totalLines = 0;
  let validEvents = 0;
  let malformedLines = 0;
  let truncatedLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    totalLines++;
    try {
      JSON.parse(trimmed);
      validEvents++;
    } catch {
      // A line cut off mid-write won't have its closing brace; a structurally
      // complete but otherwise invalid line will.
      if (trimmed.endsWith("}")) {
        malformedLines++;
      } else {
        truncatedLines++;
      }
    }
  }

  return {
    storePath,
    totalLines,
    validEvents,
    malformedLines,
    truncatedLines,
    tmpLeftover: await findTmpLeftover(dir),
  };
}

/** Copy `content` to `events.jsonl.bak`, rotating any existing backup to `.bak.bak`. */
async function writeBackup(dir: string, content: string): Promise<string> {
  const bakPath = join(dir, "events.jsonl.bak");
  const bakBakPath = join(dir, "events.jsonl.bak.bak");
  try {
    const prev = await readFile(bakPath, "utf-8");
    await writeFile(bakBakPath, prev, "utf-8");
  } catch {
    // No existing backup to rotate.
  }
  await writeFile(bakPath, content, "utf-8");
  return bakPath;
}

export interface FixStoreResult {
  /** Path of the backup written before repair, or null if there was no store file. */
  backupPath: string | null;
  /** Number of unparseable lines removed. */
  removed: number;
  /** Number of valid events retained. */
  kept: number;
  /** Path of a stray temp file that was removed, or null. */
  removedTmp: string | null;
}

/**
 * Rewrite the event store keeping only parseable lines. The original file is
 * backed up to `events.jsonl.bak` first, and any leftover `events.jsonl.tmp`
 * is removed. Serialized through the write queue so it never races a concurrent
 * append/prune/clear.
 */
export function fixStore(dir = STORE_DIR): Promise<FixStoreResult> {
  return enqueueWrite(dir, async () => {
    await ensureStoreDir(dir);
    const storePath = join(dir, "events.jsonl");

    let raw: string | null = null;
    try {
      raw = await readFile(storePath, "utf-8");
    } catch {
      // No store file — nothing to rewrite, but still clean up any temp leftover.
    }

    let backupPath: string | null = null;
    let removed = 0;
    let kept = 0;
    if (raw !== null) {
      backupPath = await writeBackup(dir, raw);
      const validLines: string[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          JSON.parse(trimmed);
          validLines.push(trimmed);
        } catch {
          removed++;
        }
      }
      kept = validLines.length;
      await writeFile(storePath, kept ? validLines.join("\n") + "\n" : "", "utf-8");
    }

    let removedTmp: string | null = null;
    const tmpPath = join(dir, "events.jsonl.tmp");
    try {
      await access(tmpPath);
      await rm(tmpPath, { force: true });
      removedTmp = tmpPath;
    } catch {
      // No leftover temp file.
    }

    return { backupPath, removed, kept, removedTmp };
  });
}
