import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { estimateTokens } from "./analyze.js";
import { expandTilde } from "./utils.js";
import type {
  ContentBlock,
  SessionLogEntry,
  SkillInvocationEvent,
  ToolResult,
  ToolUse,
} from "./types.js";

// Directories a scan should never be pointed at, even if CC_PROJECTS_DIR asks
// for them. The real-world risk is low — the env var is set by the same user
// running the CLI, not an attacker — but rejecting these outright costs
// nothing and matches OSS best practice (#147).
const DISALLOWED_PROJECTS_DIRS = ["/etc", "/sys", "/proc", "/dev"];

/**
 * Resolve and validate a candidate CC_PROJECTS_DIR value: expands `~`,
 * normalizes to an absolute path, and rejects a handful of clearly
 * inappropriate system directories (#147).
 * @throws {Error} if the resolved path is one of the disallowed roots.
 */
export function validateProjectsDir(raw: string): string {
  const resolved = resolve(expandTilde(raw));
  const isDisallowed = DISALLOWED_PROJECTS_DIRS.some(
    (d) => resolved === d || resolved.startsWith(d + sep)
  );
  if (isDisallowed) {
    throw new Error(`CC_PROJECTS_DIR "${resolved}" is not allowed for security reasons`);
  }
  return resolved;
}

// Read at call time so tests and CLI can override via CC_PROJECTS_DIR at runtime (#38)
function getProjectsDir(): string {
  const raw = process.env.CC_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
  return validateProjectsDir(raw);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Concurrency limiter ─────────────────────────────────────────────────────

/**
 * Map over `items` with at most `limit` promises in flight (#138).
 * Preserves input order in the result array.
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
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

// Entry `type` values used by Claude Code session logs. Kept permissive so a
// format change on the upstream side degrades gracefully rather than dropping
// every file.
const CLAUDE_ENTRY_TYPES = new Set([
  "message",
  "tool_result",
  "summary",
  "user",
  "assistant",
  "system",
]);

/**
 * Cheap heuristic that a `.jsonl` file is actually a Claude Code session log.
 * Only the first few non-empty lines are inspected, so unrelated JSONL files
 * that happen to live under `CC_PROJECTS_DIR` are skipped without being fully
 * read or mis-parsed as skill invocations (#171).
 */
export async function isClaudeSessionFile(filePath: string): Promise<boolean> {
  const stream = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let checked = 0;
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (++checked > 5) break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // tolerate a malformed leading line
      }
      if (!parsed || typeof parsed !== "object") continue;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.sessionId === "string") return true;
      if (typeof obj.type === "string" && CLAUDE_ENTRY_TYPES.has(obj.type)) return true;
      const message = obj.message;
      if (message && typeof message === "object" && "role" in message) return true;
    }
    return false;
  } finally {
    rl.close();
    stream.destroy();
  }
}

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

/** One discovered Claude Code session file. */
export interface SessionFileInfo {
  path: string;
  /** File modification time in epoch ms (used by scan --resume, #165). */
  mtimeMs: number;
}

/**
 * List session files, optionally scoped to one session ID.
 *
 * Claude Code names session files `<sessionId>.jsonl`, so when a session
 * filter is given we skip unrelated files by name instead of reading every
 * session file (#188). If the naming convention ever changes and the filter
 * matches nothing, callers should fall back to an unscoped listing so the
 * post-read sessionId filter can still recover the session.
 */
export async function listSessionFiles(sessionId?: string): Promise<SessionFileInfo[]> {
  const files: SessionFileInfo[] = [];
  // A rejected (dangerous) CC_PROJECTS_DIR should be a loud, visible error —
  // not silently swallowed into "no session files found" (#147).
  const projectsDir = getProjectsDir();
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        `[cc-skill-trace] Warning: CC_PROJECTS_DIR "${projectsDir}" does not exist\n`
      );
    }
    return files;
  }
  for (const projectDir of projectDirs) {
    const projectPath = join(projectsDir, projectDir);
    try {
      const s = await stat(projectPath);
      if (!s.isDirectory()) continue;
      const sessionFiles = await readdir(projectPath);
      for (const f of sessionFiles) {
        if (!f.endsWith(".jsonl")) continue;
        if (sessionId && basename(f, ".jsonl") !== sessionId) continue;
        const full = join(projectPath, f);
        try {
          files.push({ path: full, mtimeMs: (await stat(full)).mtimeMs });
        } catch {
          // skip unreadable files
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return files;
}

// ─── Core extraction logic ───────────────────────────────────────────────────

/** Options for {@link extractInvocationsFromFile}. */
export interface ExtractOptions {
  /** Max stored length of triggerMessage (default 300) (#120). */
  triggerMaxLen?: number;
  /** When false, omit triggerMessage entirely (#74). */
  captureTriggerMessages?: boolean;
}

/**
 * Extract all Skill tool invocations from a single JSONL session file.
 * For each invocation we also capture the nearest preceding user message
 * so we can show "why did this trigger".
 */
export async function extractInvocationsFromFile(
  filePath: string,
  opts: ExtractOptions = {}
): Promise<SkillInvocationEvent[]> {
  const maxLen = opts.triggerMaxLen ?? 300;
  const capture = opts.captureTriggerMessages ?? true;
  const events: SkillInvocationEvent[] = [];

  // Skip files that are not Claude Code session logs so a stray `.jsonl`
  // under CC_PROJECTS_DIR is not parsed as skill invocations (#171).
  if (!(await isClaudeSessionFile(filePath))) {
    if (process.env.CC_DEBUG) {
      process.stderr.write(`[cc-skill-trace] skipping non-session file: ${filePath}\n`);
    }
    return events;
  }

  const entries: SessionLogEntry[] = [];

  for await (const entry of readJsonlFile(filePath)) {
    entries.push(entry);
  }

  // Scan through entries looking for assistant messages that contain a Skill tool_use
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
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
      const prev = entries[j]!;
      if (!prev.message || prev.message.role !== "user") continue;
      const content = prev.message.content;
      if (typeof content === "string") {
        triggerMessage = content.slice(0, maxLen);
      } else {
        const textBlocks = (content as ContentBlock[])
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join(" ");
        triggerMessage = textBlocks.slice(0, maxLen);
      }
      break;
    }

    for (const call of skillCalls) {
      const skillName = String(call.input.skill ?? call.input.name ?? "unknown");
      const skillArgs = call.input.args ? String(call.input.args) : undefined;

      // Detect user-invoked vs Claude auto-invoked.
      // Prefer the authoritative `user_invoked` flag if Claude Code recorded it
      // on the tool_use block or the entry — this matches how the real-time
      // hook-capture path determines `source`. Fall back to inferring from the
      // preceding message text only when the flag is absent (#177).
      const explicitUserInvoked =
        typeof call.user_invoked === "boolean"
          ? call.user_invoked
          : typeof entry.user_invoked === "boolean"
            ? entry.user_invoked
            : undefined;

      const bareSkillName = skillName.includes(":") ? skillName.split(":").pop()! : skillName;
      const slashCmdRe = new RegExp(
        `^/(${escapeRegExp(skillName)}|${escapeRegExp(bareSkillName)})(\\s|$)`,
        "i"
      );
      const isUserInvoked =
        explicitUserInvoked ?? slashCmdRe.test(triggerMessage?.trimStart() ?? "");

      // Estimate injectedTokens from the tool_result that follows this call (#34).
      // The next user message should contain a tool_result block with matching tool_use_id.
      let injectedTokens: number | undefined;
      for (let j = i + 1; j < Math.min(i + 4, entries.length); j++) {
        const next = entries[j]!;
        if (!next.message) continue;
        if (next.message.role !== "user") break;
        const content = next.message.content;
        if (typeof content === "string") break;
        const result = (content as ContentBlock[]).find(
          (b): b is ToolResult => b.type === "tool_result" && b.tool_use_id === call.id
        );
        if (result) {
          const text =
            typeof result.content === "string"
              ? result.content
              : (result.content as Array<{ type: string; text?: string }>)
                  .filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join("");
          if (text) injectedTokens = estimateTokens(text);
          break;
        }
      }

      events.push({
        id: call.id,
        timestamp: entry.timestamp,
        sessionId: entry.sessionId ?? basename(filePath, ".jsonl"),
        skillName,
        skillArgs,
        source: isUserInvoked ? "user" : "claude",
        triggerMessage: capture ? triggerMessage : undefined,
        injectedTokens,
        cwd: entry.cwd,
        gitBranch: entry.gitBranch,
        recordedVia: "scan",
      });
    }
  }

  return events;
}

/** Options for {@link extractAllInvocations}. */
export interface ExtractAllOptions extends ExtractOptions {
  /** Only include events with timestamp >= this ISO string. */
  since?: string;
  /** Only include events from this session. */
  sessionId?: string;
  /** Only process session files modified after this epoch ms (scan --resume, #165). */
  modifiedAfterMs?: number;
  /** Restrict the scan to these files (used by scan --watch, #128). */
  files?: string[];
  /** Progress callback: (done, total, currentFile) (#140). */
  onProgress?: (done: number, total: number, file?: string) => void;
}

/**
 * Scan all Claude Code session files and return skill invocation events.
 * Processes files with a concurrency limit to avoid overwhelming the OS.
 */
export async function extractAllInvocations(
  opts: ExtractAllOptions = {}
): Promise<SkillInvocationEvent[]> {
  let fileInfos = await listSessionFiles(opts.sessionId);
  // Fallback: if a session filter matched no files by name (e.g. Claude Code's
  // file-naming convention changed), scan everything so the post-read sessionId
  // filter below can still recover the session. (#188)
  if (opts.sessionId && fileInfos.length === 0) {
    fileInfos = await listSessionFiles();
  }
  if (opts.modifiedAfterMs != null) {
    fileInfos = fileInfos.filter((f) => f.mtimeMs > opts.modifiedAfterMs!);
  }
  let files = fileInfos.map((f) => f.path);
  if (opts.files) {
    const allow = new Set(opts.files);
    files = files.filter((f) => allow.has(f));
  }
  const allEvents: SkillInvocationEvent[] = [];
  let done = 0;

  const concurrency = Math.max(1, parseInt(process.env.CC_SCAN_CONCURRENCY ?? "8", 10) || 8);
  await mapWithLimit(files, concurrency, async (file) => {
    try {
      const events = await extractInvocationsFromFile(file, opts);
      for (const ev of events) {
        if (opts.since && ev.timestamp < opts.since) continue;
        if (opts.sessionId && ev.sessionId !== opts.sessionId) continue;
        allEvents.push(ev);
      }
    } catch {
      // skip unreadable files
    }
    opts.onProgress?.(++done, files.length, file);
  });

  return allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Newest mtime among the given session files (helper for scan --resume, #165). */
export function newestMtimeMs(files: SessionFileInfo[]): number {
  return files.reduce((max, f) => Math.max(max, f.mtimeMs), 0);
}
