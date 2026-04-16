import type { SkillInvocationEvent } from "./types.js";
/**
 * Extract all Skill tool invocations from a single JSONL session file.
 * For each invocation we also capture the nearest preceding user message
 * so we can show "why did this trigger".
 */
export declare function extractInvocationsFromFile(filePath: string): Promise<SkillInvocationEvent[]>;
/**
 * Scan all Claude Code session files and return skill invocation events.
 * Pass `since` (ISO string) to limit to recent sessions.
 */
export declare function extractAllInvocations(opts?: {
    since?: string;
    sessionId?: string;
}): Promise<SkillInvocationEvent[]>;
//# sourceMappingURL=parser.d.ts.map