import type { Command } from "commander";
import { getConfig } from "../context.js";
import { appendEvent, readEvents, readLastEvent, updateEvent } from "../../core/store.js";
import type { HookPayload, SkillInvocationEvent } from "../../core/types.js";
import { postWebhook } from "../ui.js";

/**
 * How long we wait for Claude Code to deliver the hook payload on stdin
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

function parsePayload(raw: string, dbg: (m: string) => void): HookPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      dbg("payload is not an object, ignoring");
      return undefined;
    }
    return parsed as HookPayload;
  } catch (err) {
    dbg(`JSON parse error: ${err}`);
    return undefined;
  }
}

/** Handle a PreToolUse payload: append one event (with dedup + optional webhook). */
async function handlePre(payload: HookPayload, dbg: (m: string) => void): Promise<void> {
  const { randomUUID } = await import("node:crypto");
  const event: SkillInvocationEvent = {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    sessionId: payload.session_id ?? "unknown",
    skillName: String(payload.tool_input.skill),
    skillArgs: payload.tool_input.args ? String(payload.tool_input.args) : undefined,
    source: payload.user_invoked ? "user" : "claude",
    cwd: payload.cwd,
    gitBranch: payload.git_branch,
    recordedVia: "hook",
  };

  // 1-second dedup window: Claude Code may fire the hook twice for retried
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
async function handlePost(payload: HookPayload, dbg: (m: string) => void): Promise<void> {
  const sessionId = payload.session_id ?? "unknown";
  const skillName = String(payload.tool_input.skill);
  const now = Date.now();

  const candidates = await readEvents({ sessionId, skill: skillName });
  const open = [...candidates]
    .reverse()
    .find((ev) => ev.outcome == null && now - Date.parse(ev.timestamp) < 10 * 60 * 1000);
  if (!open) {
    dbg("no open event found for PostToolUse payload, ignoring");
    return;
  }

  const response = payload.tool_response as { is_error?: boolean } | undefined;
  const outcome = response && response.is_error === true ? "error" : "ok";
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
    .helpOption(false)
    .action(async (opts: { post?: boolean }) => {
      const dbg = debugLogger();
      // Everything below is wrapped so the hook can never block Claude Code:
      // all exits are code 0 and stdout is always valid hook JSON.
      try {
        const raw = await readStdinBounded(dbg);
        if (raw != null) {
          const payload = parsePayload(raw, dbg);
          if (payload && payload.tool_name === "Skill" && payload.tool_input?.skill) {
            if (opts.post) await handlePost(payload, dbg);
            else await handlePre(payload, dbg);
          } else if (payload) {
            dbg(`not a Skill invocation (tool_name=${payload.tool_name}), ignoring`);
          }
        }
      } catch (err) {
        dbg(`unexpected error: ${err}`);
      }
      process.stdout.write(JSON.stringify({}));
      process.exit(0);
    });
}
