import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInvocationEvent } from "./types.js";

export const STORE_DIR = join(homedir(), ".cc-skill-trace");
export const EVENTS_FILE = join(STORE_DIR, "events.jsonl");

export async function ensureStoreDir(dir = STORE_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
}

// ─── Cross-process file lock ─────────────────────────────────────────────────
// The in-process write queue (below) only serializes writes within a *single*
// process. When Claude Code fires skills in parallel it can spawn several
// `hook-capture` processes at once, and the user may run `clear`/prune from the
// CLI while a session is live — all separate OS processes contending for the
// same events.jsonl. Appends are safe on their own (fs.appendFile opens with
// O_APPEND, so each small line is written atomically and never interleaves),
// but the whole-file read-modify-write operations (prune/clear/backup) can
// silently clobber a concurrent append: they read the file, then overwrite it
// with the old contents, dropping anything appended in between.
//
// We coordinate those operations across processes with an advisory lock built
// on exclusive file creation (`open(path, "wx")` fails with EEXIST if the lock
// already exists). A lock file older than LOCK_STALE_MS is presumed to belong
// to a crashed holder and is reclaimed, so a dead process can never deadlock
// the store (#161).

const LOCK_STALE_MS = 30_000; // a lock file older than this is treated as abandoned
const LOCK_POLL_MS = 15; // interval between acquisition attempts while a lock is held
/** Whole-file rewrites (prune/clear/backup) wait this long before giving up. */
const LOCK_WAIT_MS = 2_000;
/**
 * Appends run on the hook hot path and must never block Claude Code, so they
 * wait only briefly for the lock and then fall back to a bare (still atomic)
 * append. Worst case this is no worse than the pre-#161 behaviour.
 */
const APPEND_LOCK_WAIT_MS = 250;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function lockPath(dir: string): string {
  return join(dir, "events.jsonl.lock");
}

/**
 * Try to acquire the cross-process lock for `dir`, waiting up to `maxWaitMs`.
 * Returns a release function on success, or `null` if the lock could not be
 * acquired in time (the caller decides whether to fall back or fail).
 */
async function acquireFileLock(
  dir: string,
  maxWaitMs: number
): Promise<(() => Promise<void>) | null> {
  await ensureStoreDir(dir);
  const path = lockPath(dir);
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf-8");
      await handle.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(path, { force: true }).catch(() => {});
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock is held — reclaim it if it looks abandoned, otherwise wait.
      try {
        const st = await stat(path);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await rm(path, { force: true }).catch(() => {});
          continue; // stale lock cleared — retry immediately
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      if (Date.now() - start >= maxWaitMs) return null;
      await delay(LOCK_POLL_MS);
    }
  }
}

/**
 * Run `fn` while holding the cross-process lock for `dir`. Throws if the lock
 * cannot be acquired within `LOCK_WAIT_MS` rather than risk clobbering a
 * concurrent write. Used for the whole-file rewrite operations.
 */
async function withFileLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireFileLock(dir, LOCK_WAIT_MS);
  if (!release) {
    throw new Error(
      `cc-skill-trace: could not acquire store lock for ${dir} within ${LOCK_WAIT_MS}ms ` +
        `(a stale ${lockPath(dir)} can be removed manually)`
    );
  }
  try {
    return await fn();
  } finally {
    await release();
  }
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
    const line = JSON.stringify(event) + "\n";
    // Coordinate with a concurrent prune/clear when we can, but never block the
    // hook: if the lock is contended past APPEND_LOCK_WAIT_MS, fall back to a
    // bare O_APPEND write (atomic on its own, so appends still never interleave).
    const release = await acquireFileLock(dir, APPEND_LOCK_WAIT_MS).catch(() => null);
    try {
      await appendFile(join(dir, "events.jsonl"), line, "utf-8");
    } finally {
      if (release) await release();
    }
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
  return enqueueWrite(dir, () =>
    withFileLock(dir, async () => {
      await ensureStoreDir(dir);
      await writeFile(join(dir, "events.jsonl"), "", "utf-8");
    })
  );
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
  return enqueueWrite(dir, () =>
    withFileLock(dir, async () => {
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
    })
  );
}

/** Remove events whose timestamp is older than `beforeIso` (ISO string).
 *  Returns counts of removed and kept events. */
export function pruneEvents(
  beforeIso: string,
  dir = STORE_DIR
): Promise<{ removed: number; kept: number }> {
  return enqueueWrite(dir, () =>
    withFileLock(dir, async () => {
      await ensureStoreDir(dir);
      const events = await readEvents(dir);
      const kept = events.filter((e) => e.timestamp >= beforeIso);
      const removed = events.length - kept.length;
      const content = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : "");
      await writeFile(join(dir, "events.jsonl"), content, "utf-8");
      return { removed, kept: kept.length };
    })
  );
}
