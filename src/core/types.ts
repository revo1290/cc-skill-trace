// ─── Claude Code JSONL session log types ────────────────────────────────────

export type MessageRole = "user" | "assistant";

export interface ToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Present when Claude Code recorded whether the invocation came from a user
   * slash command. When available this is authoritative and should be preferred
   * over inferring `source` from the preceding message text (#177).
   */
  user_invoked?: boolean;
}

export interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
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
  cwd?: string;
  gitBranch?: string;
  /**
   * Entry-level flag set by Claude Code when the invocation was triggered by a
   * user slash command. Preferred over regex inference of `source` (#177).
   */
  user_invoked?: boolean;
  costUSD?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// ─── cc-skill-trace event types ─────────────────────────────────────────────

/**
 * Current version of the on-disk event schema (#94).
 * - v1 (implicit, no `v` field): original schema up to cc-skill-trace 1.x
 * - v2: adds `v`, `recordedVia`, `tags`, `outcome`, `durationMs`
 * - v3: adds `provider` (multi-agent-CLI support)
 *
 * Readers MUST accept events without a `v` field and treat them as v1.
 */
export const EVENT_SCHEMA_VERSION = 3;

export type InvocationSource = "user" | "claude" | "unknown";

/** How an event entered the store: real-time hook capture or retroactive scan (#148). */
export type RecordedVia = "hook" | "scan";

/** Result of a skill invocation, when known via the PostToolUse hook (#144). */
export type InvocationOutcome = "ok" | "error";

/**
 * Which agent CLI produced this event. Absent on events recorded before v3 —
 * always treat a missing `provider` as `"claude-code"`, the original and
 * still-default target.
 */
export type ProviderId = "claude-code" | "codex" | "copilot";

/** Stored in ~/.cc-skill-trace/events.jsonl */
export interface SkillInvocationEvent {
  /** Unique event ID */
  id: string;
  /** Event schema version (#94). Absent on legacy v1 events. */
  v?: number;
  /** ISO timestamp when the skill was invoked */
  timestamp: string;
  /** Session ID assigned by the originating agent CLI */
  sessionId: string;
  /** Name of the invoked skill */
  skillName: string;
  /** Arguments passed to the skill (if any) */
  skillArgs?: string;
  /** Whether invoked by the user (slash command) or by the agent automatically */
  source: InvocationSource;
  /** The user message text that immediately preceded this invocation */
  triggerMessage?: string;
  /** Number of tokens in the skill content injected into context */
  injectedTokens?: number;
  /** Working directory at time of invocation */
  cwd?: string;
  /** Git branch at time of invocation */
  gitBranch?: string;
  /** How the event was recorded: real-time hook or retroactive scan (#148) */
  recordedVia?: RecordedVia;
  /** User-assigned labels, e.g. "false-positive" (#127) */
  tags?: string[];
  /** Invocation result reported by the PostToolUse hook (#144) */
  outcome?: InvocationOutcome;
  /** Milliseconds between PreToolUse and PostToolUse hooks, when both fired (#144) */
  durationMs?: number;
  /** Which agent CLI produced this event. Absent (legacy) means "claude-code". */
  provider?: ProviderId;
}

// ─── Hook stdin payload (PreToolUse / PostToolUse) ──────────────────────────

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
  /** PostToolUse only: the tool's response (shape varies by tool) */
  tool_response?: unknown;
  cwd?: string;
  git_branch?: string;
}
