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
