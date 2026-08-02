import type { Command } from "commander";
import { getConfig } from "../context.js";
import { getProvider } from "../../core/providers/index.js";
import { appendEvent, readEvents, readLastEvent, updateEvent } from "../../core/store.js";
import type { HookPayload, ProviderId, SkillInvocationEvent } from "../../core/types.js";
import { postWebhook } from "../ui.js";

/**
 * How long we wait for the agent CLI to deliver the hook payload on stdin
 * before giving up (#91). Hooks must never hang the session.
 */
const STDIN_TIMEOUT_MS = 3000;

/** Two events for the same skill within this window are considered duplicates (#70). */
const DEDUP_WINDOW_MS = 1000;

function debugLogger(): (msg: string) => void {
  const enabled = process.env.CC_DEBUG === "1";
  return (msg: string) => {
    if (enabled) process.stderr.write(`[cc-skill-trace] ${msg}\n`);
  };
}

/** Read all of stdin, bounded by size (#76) and time (#91). Returns undefined on timeout/overflow. */
async function readStdinBounded(dbg: (m: string) => void): Promise<string | undefined> {
  const maxKb = Math.max(1, parseInt(process.env.CC_MAX_STDIN_KB ?? "64", 10) || 64);
  const maxBytes = maxKb * 1024;

  let raw = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    process.stdin.destroy();
  }, STDIN_TIMEOUT_MS);

  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > maxBytes) {
        dbg(`stdin exceeded ${maxKb} KB limit, ignoring`);
        return undefined;
      }
    }
  } catch {
    // destroyed by the timeout — fall through
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    dbg(`stdin timed out after ${STDIN_TIMEOUT_MS}ms, ignoring`);
    return undefined;
  }
  return raw;
}

function parsePayload(raw: string, dbg: (m: string) => void): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      dbg("payload is not an object, ignoring");
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    dbg(`JSON parse error: ${err}`);
    return undefined;
  }
}

/** hook-capture never throws; an unrecognized --provider value falls back to claude-code (#v3-multi-provider). */
function resolveHookProviderId(raw: string | undefined, dbg: (m: string) => void): ProviderId {
  if (raw === "codex" || raw === "copilot" || raw === "claude-code") return raw;
  if (raw) dbg(`unknown --provider "${raw}", defaulting to claude-code`);
  return "claude-code";
}

// ─── Per-provider payload parsing ──────────────────────────────────────────
//
// Claude Code's shape (session_id, tool_name, tool_input.skill) is
// documented and stable. Codex CLI and GitHub Copilot CLI have no dedicated
// "skill" tool call, so their hook payloads are matched the same way as the
// scan-based providers (src/core/providers/{codex,copilot}.ts): does the
// tool call's arguments reference a known skill's SKILL.md path on disk?
// This is best-effort — neither payload shape below has been exercised
// against a live hook firing (#v3-multi-provider).

interface ParsedPre {
  sessionId: string;
  skillName: string;
  skillArgs?: string;
  isUserInvoked: boolean;
  cwd?: string;
  gitBranch?: string;
}

interface ParsedPost {
  sessionId: string;
  skillName: string;
  isError: boolean;
}

function parseClaudeCodePre(payload: HookPayload): ParsedPre | undefined {
  if (payload.tool_name !== "Skill" || !payload.tool_input?.skill) return undefined;
  return {
    sessionId: payload.session_id ?? "unknown",
    skillName: String(payload.tool_input.skill),
    skillArgs: payload.tool_input.args ? String(payload.tool_input.args) : undefined,
    isUserInvoked: !!payload.user_invoked,
    cwd: payload.cwd,
    gitBranch: payload.git_branch,
  };
}

function parseClaudeCodePost(payload: HookPayload): ParsedPost | undefined {
  if (payload.tool_name !== "Skill" || !payload.tool_input?.skill) return undefined;
  const response = payload.tool_response as { is_error?: boolean } | undefined;
  return {
    sessionId: payload.session_id ?? "unknown",
    skillName: String(payload.tool_input.skill),
    isError: response?.is_error === true,
  };
}

/** Does this serialized tool call reference a known installed skill's SKILL.md path? */
async function matchInstalledSkill(
  provider: "codex" | "copilot",
  haystack: string
): Promise<{ name: string } | undefined> {
  const skills = await getProvider(provider).listInstalledSkills();
  return skills.find((s) => haystack.includes(s.path));
}

// Codex hook payloads are documented as snake_case, modeled after Claude
// Code's own hook system: session_id, cwd, tool_name, tool_input. The tool
// used to read a SKILL.md is a generic shell tool (observed as "exec_command"
// in session logs; hook docs describe it surfacing as "Bash").
interface CodexHookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { is_error?: boolean };
}

async function parseCodexPre(raw: Record<string, unknown>): Promise<ParsedPre | undefined> {
  const payload = raw as CodexHookPayload;
  const haystack = JSON.stringify(payload.tool_input ?? {});
  const matched = await matchInstalledSkill("codex", haystack);
  if (!matched) return undefined;
  return {
    sessionId: payload.session_id ?? "unknown",
    skillName: matched.name,
    // Not observable from the hook payload alone (no message text is
    // delivered with PreToolUse) — default to "auto" (#v3-multi-provider).
    isUserInvoked: false,
    cwd: payload.cwd,
  };
}

async function parseCodexPost(raw: Record<string, unknown>): Promise<ParsedPost | undefined> {
  const payload = raw as CodexHookPayload;
  const haystack = JSON.stringify(payload.tool_input ?? {});
  const matched = await matchInstalledSkill("codex", haystack);
  if (!matched) return undefined;
  return {
    sessionId: payload.session_id ?? "unknown",
    skillName: matched.name,
    isError: payload.tool_response?.is_error === true,
  };
}

// GitHub Copilot CLI hook payloads are documented camelCase:
// sessionId, cwd, toolName, toolArgs, and (PostToolUse only)
// toolResult: { resultType, textResultForLlm }.
interface CopilotHookPayload {
  sessionId?: string;
  cwd?: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: { resultType?: string };
}

async function parseCopilotPre(raw: Record<string, unknown>): Promise<ParsedPre | undefined> {
  const payload = raw as CopilotHookPayload;
  const haystack = JSON.stringify(payload.toolArgs ?? {});
  const matched = await matchInstalledSkill("copilot", haystack);
  if (!matched) return undefined;
  return {
    sessionId: payload.sessionId ?? "unknown",
    skillName: matched.name,
    isUserInvoked: false,
    cwd: payload.cwd,
  };
}

async function parseCopilotPost(raw: Record<string, unknown>): Promise<ParsedPost | undefined> {
  const payload = raw as CopilotHookPayload;
  const haystack = JSON.stringify(payload.toolArgs ?? {});
  const matched = await matchInstalledSkill("copilot", haystack);
  if (!matched) return undefined;
  return {
    sessionId: payload.sessionId ?? "unknown",
    skillName: matched.name,
    isError: payload.toolResult?.resultType === "error",
  };
}

async function parsePreForProvider(
  provider: ProviderId,
  payload: Record<string, unknown>
): Promise<ParsedPre | undefined> {
  if (provider === "claude-code") return parseClaudeCodePre(payload as unknown as HookPayload);
  if (provider === "codex") return parseCodexPre(payload);
  return parseCopilotPre(payload);
}

async function parsePostForProvider(
  provider: ProviderId,
  payload: Record<string, unknown>
): Promise<ParsedPost | undefined> {
  if (provider === "claude-code") return parseClaudeCodePost(payload as unknown as HookPayload);
  if (provider === "codex") return parseCodexPost(payload);
  return parseCopilotPost(payload);
}

// ─── Store writes (provider-agnostic once parsed) ──────────────────────────

/** Handle a PreToolUse payload: append one event (with dedup + optional webhook). */
async function handlePre(
  parsed: ParsedPre,
  provider: ProviderId,
  dbg: (m: string) => void
): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const event: SkillInvocationEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: parsed.sessionId,
    skillName: parsed.skillName,
    skillArgs: parsed.skillArgs,
    source: parsed.isUserInvoked ? "user" : "claude",
    cwd: parsed.cwd,
    gitBranch: parsed.gitBranch,
    recordedVia: "hook",
    provider,
  };

  // 1-second dedup window: the agent CLI may fire the hook twice for retried
  // tool calls; identical skill+session within the window is one invocation (#70).
  const last = await readLastEvent().catch(() => undefined);
  if (
    last &&
    last.sessionId === event.sessionId &&
    last.skillName === event.skillName &&
    last.source === event.source &&
    Math.abs(Date.parse(event.timestamp) - Date.parse(last.timestamp)) < DEDUP_WINDOW_MS
  ) {
    dbg("duplicate event within dedup window, skipping");
    return;
  }

  dbg(`capturing ${event.source} invocation of "${event.skillName}" in session ${event.sessionId}`);
  try {
    await appendEvent(event);
    dbg("event appended");
  } catch (err) {
    dbg(`appendEvent failed: ${err}`);
  }

  // Optional webhook fan-out (#139) — bounded, never throws.
  try {
    const config = await getConfig();
    if (config.webhookUrl) {
      await postWebhook(
        config.webhookUrl,
        { type: "skill_invocation", event },
        config.webhookTimeoutMs
      );
      dbg(`webhook posted to ${config.webhookUrl}`);
    }
  } catch {
    // config load failures must not break the hook
  }
}

/** Handle a PostToolUse payload: mark the matching event's outcome (#144). */
async function handlePost(
  parsed: ParsedPost,
  provider: ProviderId,
  dbg: (m: string) => void
): Promise<void> {
  const now = Date.now();

  const candidates = await readEvents({ sessionId: parsed.sessionId, skill: parsed.skillName, provider });
  const open = [...candidates]
    .reverse()
    .find((ev) => ev.outcome == null && now - Date.parse(ev.timestamp) < 10 * 60 * 1000);
  if (!open) {
    dbg("no open event found for PostToolUse payload, ignoring");
    return;
  }

  const outcome = parsed.isError ? "error" : "ok";
  const durationMs = Math.max(0, now - Date.parse(open.timestamp));
  try {
    await updateEvent(open.id, { outcome, durationMs });
    dbg(`marked ${open.id} outcome=${outcome} duration=${durationMs}ms`);
  } catch (err) {
    dbg(`updateEvent failed: ${err}`);
  }
}

export function registerCaptureCommand(program: Command): void {
  program
    .command("hook-capture", { hidden: true })
    .description("Internal: receives PreToolUse/PostToolUse hook payload via stdin")
    .option("--post", "Treat the payload as PostToolUse and record the outcome (#144)")
    .option(
      "--provider <id>",
      "Which agent CLI's hook payload shape to parse: claude-code (default), codex, copilot (#v3-multi-provider)"
    )
    .helpOption(false)
    .action(async (opts: { post?: boolean; provider?: string }) => {
      const dbg = debugLogger();
      // Everything below is wrapped so the hook can never block the agent CLI:
      // all exits are code 0 and stdout is always valid hook JSON.
      try {
        const providerId = resolveHookProviderId(opts.provider, dbg);
        const raw = await readStdinBounded(dbg);
        if (raw != null) {
          const payload = parsePayload(raw, dbg);
          if (payload) {
            if (opts.post) {
              const parsed = await parsePostForProvider(providerId, payload);
              if (parsed) await handlePost(parsed, providerId, dbg);
              else dbg(`not a recognized skill invocation for provider=${providerId}`);
            } else {
              const parsed = await parsePreForProvider(providerId, payload);
              if (parsed) await handlePre(parsed, providerId, dbg);
              else dbg(`not a recognized skill invocation for provider=${providerId}`);
            }
          }
        }
      } catch (err) {
        dbg(`unexpected error: ${err}`);
      }
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    });
}
