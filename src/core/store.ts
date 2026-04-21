import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInvocationEvent } from "./types.js";

export const STORE_DIR = join(homedir(), ".cc-skill-trace");
export const EVENTS_FILE = join(STORE_DIR, "events.jsonl");

export async function ensureStoreDir(dir = STORE_DIR): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function appendEvent(event: SkillInvocationEvent, dir = STORE_DIR): Promise<void> {
  await ensureStoreDir(dir);
  await appendFile(join(dir, "events.jsonl"), JSON.stringify(event) + "\n", "utf-8");
}

export async function readEvents(dir = STORE_DIR): Promise<SkillInvocationEvent[]> {
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
      events.push(JSON.parse(line) as SkillInvocationEvent);
    } catch {
      // skip malformed lines without losing the rest
    }
  }
  return events;
}

export async function clearEvents(dir = STORE_DIR): Promise<void> {
  await ensureStoreDir(dir);
  await writeFile(join(dir, "events.jsonl"), "", "utf-8");
}

/** Remove events whose timestamp is older than `beforeIso` (ISO string).
 *  Returns counts of removed and kept events. */
export async function pruneEvents(
  beforeIso: string,
  dir = STORE_DIR,
): Promise<{ removed: number; kept: number }> {
  await ensureStoreDir(dir);
  const events = await readEvents(dir);
  const kept = events.filter((e) => e.timestamp >= beforeIso);
  const removed = events.length - kept.length;
  const content = kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : "");
  await writeFile(join(dir, "events.jsonl"), content, "utf-8");
  return { removed, kept: kept.length };
}
