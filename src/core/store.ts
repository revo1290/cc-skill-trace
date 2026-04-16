import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInvocationEvent } from "./types.js";

const STORE_DIR = join(homedir(), ".cc-skill-trace");
const EVENTS_FILE = join(STORE_DIR, "events.jsonl");

export async function ensureStoreDir(): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
}

export async function appendEvent(event: SkillInvocationEvent): Promise<void> {
  await ensureStoreDir();
  await appendFile(EVENTS_FILE, JSON.stringify(event) + "\n", "utf-8");
}

export async function readEvents(): Promise<SkillInvocationEvent[]> {
  try {
    const raw = await readFile(EVENTS_FILE, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SkillInvocationEvent);
  } catch {
    return [];
  }
}

export async function clearEvents(): Promise<void> {
  await ensureStoreDir();
  await writeFile(EVENTS_FILE, "", "utf-8");
}

export { STORE_DIR, EVENTS_FILE };
