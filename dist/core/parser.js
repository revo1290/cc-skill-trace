import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
// ─── JSONL file helpers ──────────────────────────────────────────────────────
async function* readJsonlFile(filePath) {
    const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
    });
    for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            yield JSON.parse(trimmed);
        }
        catch {
            // skip malformed lines
        }
    }
}
async function findAllSessionFiles() {
    const files = [];
    let projectDirs;
    try {
        projectDirs = await readdir(CLAUDE_PROJECTS_DIR);
    }
    catch {
        return files;
    }
    for (const projectDir of projectDirs) {
        const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir);
        try {
            const s = await stat(projectPath);
            if (!s.isDirectory())
                continue;
            const sessionFiles = await readdir(projectPath);
            for (const f of sessionFiles) {
                if (f.endsWith(".jsonl")) {
                    files.push(join(projectPath, f));
                }
            }
        }
        catch {
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
export async function extractInvocationsFromFile(filePath) {
    const events = [];
    const entries = [];
    for await (const entry of readJsonlFile(filePath)) {
        entries.push(entry);
    }
    // Scan through entries looking for assistant messages that contain a Skill tool_use
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!entry.message)
            continue;
        const msg = entry.message;
        if (msg.role !== "assistant")
            continue;
        if (typeof msg.content === "string")
            continue;
        const skillCalls = msg.content.filter((block) => block.type === "tool_use" && block.name === "Skill");
        if (skillCalls.length === 0)
            continue;
        // Find the most recent user message before this entry
        let triggerMessage;
        for (let j = i - 1; j >= 0; j--) {
            const prev = entries[j];
            if (!prev.message || prev.message.role !== "user")
                continue;
            const content = prev.message.content;
            if (typeof content === "string") {
                triggerMessage = content.slice(0, 300);
            }
            else {
                const textBlocks = content
                    .filter((b) => b.type === "text")
                    .map((b) => b.text)
                    .join(" ");
                triggerMessage = textBlocks.slice(0, 300);
            }
            break;
        }
        for (const call of skillCalls) {
            const skillName = String(call.input.skill ?? call.input.name ?? "unknown");
            const skillArgs = call.input.args ? String(call.input.args) : undefined;
            // Detect user-invoked vs Claude auto-invoked:
            // User invocations appear immediately after a user message starting with "/" + skillName
            const isUserInvoked = triggerMessage?.trimStart().startsWith(`/${skillName}`) ?? false;
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
 * Pass `since` (ISO string) to limit to recent sessions.
 */
export async function extractAllInvocations(opts = {}) {
    const files = await findAllSessionFiles();
    const allEvents = [];
    await Promise.all(files.map(async (file) => {
        try {
            const events = await extractInvocationsFromFile(file);
            for (const ev of events) {
                if (opts.since && ev.timestamp < opts.since)
                    continue;
                if (opts.sessionId && ev.sessionId !== opts.sessionId)
                    continue;
                allEvents.push(ev);
            }
        }
        catch {
            // skip unreadable files
        }
    }));
    return allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
//# sourceMappingURL=parser.js.map