import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import type { SessionLogEntry, SkillInvocationEvent, ToolUse, ContentBlock } from "./types.js";

const CLAUDE_PROJECTS_DIR =
  process.env["CC_PROJECTS_DIR"] ?? join(homedir(), ".claude", "projects");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Concurrency limiter ─────────────────────────────────────────────────────

async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: (R | undefined)[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results as R[];
}

// ─── JSONL file helpers ──────────────────────────────────────────────────────

async function* readJsonlFile(filePath: string): AsyncGenerator<SessionLogEntry> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as SessionLogEntry;
    } catch {
      // skip malformed lines
    }
  }
}

async function findAllSessionFiles(): Promise<string[]> {
  const files: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
  } catch {
    return files;
  }
  for (const projectDir of projectDirs) {
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);
    try {
      const s = await stat(projectPath);
      if (!s.isDirectory()) continue;
      const sessionFiles = await readdir(projectPath);
      for (const f of sessionFiles) {
        if (f.endsWith(".jsonl")) {
          files.push(join(projectPath, f));
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return files;
}

// ─── Core extraction logic ───────────────────────────────────────────────────

/**
 * Extract all Skill tool invocations from a single JSONL session file.
 * For each invocation we also capture the nearest preceding user message
 * so we can show "why did this trigger".
 */
export async function extractInvocationsFromFile(
  filePath: string
): Promise<SkillInvocationEvent[]> {
  const events: SkillInvocationEvent[] = [];
  const entries: SessionLogEntry[] = [];

  for await (const entry of readJsonlFile(filePath)) {
    entries.push(entry);
  }

  // Scan through entries looking for assistant messages that contain a Skill tool_use
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.message) continue;
    const msg = entry.message;
    if (msg.role !== "assistant") continue;
    if (typeof msg.content === "string") continue;

    const skillCalls = (msg.content as ContentBlock[]).filter(
      (block): block is ToolUse => block.type === "tool_use" && block.name === "Skill"
    );
    if (skillCalls.length === 0) continue;

    // Find the most recent user message before this entry
    let triggerMessage: string | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const prev = entries[j];
      if (!prev.message || prev.message.role !== "user") continue;
      const content = prev.message.content;
      if (typeof content === "string") {
        triggerMessage = content.slice(0, 300);
      } else {
        const textBlocks = (content as ContentBlock[])
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join(" ");
        triggerMessage = textBlocks.slice(0, 300);
      }
      break;
    }

    for (const call of skillCalls) {
      const skillName = String(call.input.skill ?? call.input.name ?? "unknown");
      const skillArgs = call.input.args ? String(call.input.args) : undefined;

      // Detect user-invoked vs Claude auto-invoked.
      // A slash command typed by the user looks like "/<skillName>" or "/<plugin>:<skillName>"
      // optionally followed by a space (for args) or end of string.
      // We match both the full qualified name (plugin:skill) and the bare skill name so that
      // "/pdf" matches skill "example-skills:pdf" as well as "pdf".
      const bareSkillName = skillName.includes(":") ? skillName.split(":").pop()! : skillName;
      const slashCmdRe = new RegExp(
        `^/(${escapeRegExp(skillName)}|${escapeRegExp(bareSkillName)})(\\s|$)`,
        "i",
      );
      const isUserInvoked = slashCmdRe.test(triggerMessage?.trimStart() ?? "");

      events.push({
        // Use the tool_use block ID as event ID — it is globally unique per invocation
        // and stable across repeated scans of the same session file.
        id: call.id,
        timestamp: entry.timestamp,
        sessionId: entry.sessionId ?? basename(filePath, ".jsonl"),
        skillName,
        skillArgs,
        source: isUserInvoked ? "user" : "claude",
        triggerMessage,
        cwd: undefined,
        gitBranch: undefined,
      });
    }
  }

  return events;
}

/**
 * Scan all Claude Code session files and return skill invocation events.
 * Processes files with a concurrency limit to avoid overwhelming the OS.
 * Pass `since` (ISO string) to limit to recent sessions.
 * Pass `onProgress` to receive (done, total) updates during scanning.
 */
export async function extractAllInvocations(opts: {
  since?: string;
  sessionId?: string;
  onProgress?: (done: number, total: number) => void;
} = {}): Promise<SkillInvocationEvent[]> {
  const files = await findAllSessionFiles();
  const allEvents: SkillInvocationEvent[] = [];
  let done = 0;

  await mapWithLimit(files, 8, async (file) => {
    try {
      const events = await extractInvocationsFromFile(file);
      for (const ev of events) {
        if (opts.since && ev.timestamp < opts.since) continue;
        if (opts.sessionId && ev.sessionId !== opts.sessionId) continue;
        allEvents.push(ev);
      }
    } catch {
      // skip unreadable files
    }
    opts.onProgress?.(++done, files.length);
  });

  return allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
