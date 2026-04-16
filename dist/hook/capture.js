#!/usr/bin/env node
/**
 * cc-skill-trace capture hook
 *
 * Register this as a PreToolUse hook in your Claude Code settings:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": "Skill",
 *         "hooks": [{ "type": "command", "command": "cc-skill-trace hook-capture" }]
 *       }]
 *     }
 *   }
 *
 * Receives a JSON payload via stdin and appends a SkillInvocationEvent to
 * ~/.cc-skill-trace/events.jsonl. Always exits 0 so Claude Code proceeds.
 */
import { randomUUID } from "node:crypto";
import { appendEvent, ensureStoreDir } from "../core/store.js";
async function main() {
    let raw = "";
    for await (const chunk of process.stdin) {
        raw += chunk;
    }
    let payload;
    try {
        payload = JSON.parse(raw);
    }
    catch {
        // Not a valid payload — pass through silently
        process.exit(0);
    }
    if (payload.tool_name !== "Skill" || !payload.tool_input.skill) {
        process.exit(0);
    }
    await ensureStoreDir();
    const event = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        sessionId: payload.session_id ?? "unknown",
        skillName: String(payload.tool_input.skill),
        skillArgs: payload.tool_input.args ? String(payload.tool_input.args) : undefined,
        source: payload.user_invoked ? "user" : "claude",
        cwd: payload.cwd,
        gitBranch: payload.git_branch,
    };
    try {
        await appendEvent(event);
    }
    catch {
        // Never block Claude Code due to logging failure
    }
    // Return empty JSON — allow the tool call to proceed unchanged
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
}
main();
//# sourceMappingURL=capture.js.map