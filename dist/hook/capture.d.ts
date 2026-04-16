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
export {};
//# sourceMappingURL=capture.d.ts.map