export type MessageRole = "user" | "assistant";
export interface ToolUse {
    type: "tool_use";
    id: string;
    name: string;
    input: Record<string, unknown>;
}
export interface ToolResult {
    type: "tool_result";
    tool_use_id: string;
    content: string | Array<{
        type: string;
        text?: string;
    }>;
    is_error?: boolean;
}
export interface TextContent {
    type: "text";
    text: string;
}
export type ContentBlock = TextContent | ToolUse | ToolResult;
export interface SessionMessage {
    role: MessageRole;
    content: string | ContentBlock[];
    timestamp?: string;
}
/** One line in a Claude Code JSONL session file */
export interface SessionLogEntry {
    type: "message" | "tool_result" | "summary";
    message?: SessionMessage;
    /** ISO timestamp */
    timestamp: string;
    sessionId?: string;
    uuid?: string;
    costUSD?: number;
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
}
export type InvocationSource = "user" | "claude" | "unknown";
/** Stored in ~/.cc-skill-trace/events.jsonl */
export interface SkillInvocationEvent {
    /** Unique event ID */
    id: string;
    /** ISO timestamp when the skill was invoked */
    timestamp: string;
    /** Claude Code session ID */
    sessionId: string;
    /** Name of the invoked skill */
    skillName: string;
    /** Arguments passed to the skill (if any) */
    skillArgs?: string;
    /** Whether invoked by user (slash command) or by Claude automatically */
    source: InvocationSource;
    /** The user message text that immediately preceded this invocation */
    triggerMessage?: string;
    /** Number of tokens in the skill content injected into context */
    injectedTokens?: number;
    /** Working directory at time of invocation */
    cwd?: string;
    /** Git branch at time of invocation */
    gitBranch?: string;
}
export interface HookPayload {
    session_id: string;
    tool_name: string;
    tool_input: {
        skill?: string;
        args?: string;
        [key: string]: unknown;
    };
    /** Present when the invocation was triggered by a user slash command */
    user_invoked?: boolean;
    cwd?: string;
    git_branch?: string;
}
//# sourceMappingURL=types.d.ts.map