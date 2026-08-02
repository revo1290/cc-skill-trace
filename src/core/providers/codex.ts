import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { estimateTokens } from "../analyze.js";
import type { ExtractAllOptions } from "../parser.js";
import type { InvocationSource, SkillInvocationEvent } from "../types.js";
import { parseSkillFrontmatter } from "./skill-md.js";
import type { Provider, ProviderSessionFile, SkillDef } from "./types.js";

/**
 * Codex CLI integration (#v3-multi-provider) — best-effort.
 *
 * Unlike Claude Code, which exposes skills through a dedicated `Skill` tool
 * (`tool_use: { name: "Skill", input: { skill } }`), Codex CLI has no
 * documented, distinct "skill invocation" event. Empirically (inspecting
 * real `~/.codex/sessions/**​/*.jsonl` rollout files), Codex tells the model
 * the skill's file path and lets the model read it via its normal shell tool
 * — a real captured invocation looks like:
 *
 *   { "type": "function_call", "name": "exec_command",
 *     "arguments": "{\"cmd\":\"sed -n '1,220p' /path/to/SKILL.md\", ...}" }
 *
 * So detection here works by cross-referencing every `function_call` /
 * `custom_tool_call`'s arguments against the absolute paths of skills known
 * to be installed, rather than matching a fixed tool/function name. This is
 * robust to *which* tool Codex uses to read the file, but it is a heuristic,
 * not a documented contract — hence `confidence: "best-effort"`.
 */

// Read at call time (not module load) so tests and the CLI can override via
// CC_CODEX_HOME at runtime, mirroring CC_PROJECTS_DIR in ../parser.ts.
function codexHome(): string {
  return process.env.CC_CODEX_HOME ?? join(homedir(), ".codex");
}

// ─── Skill discovery ──────────────────────────────────────────────────────

async function findSkillMdRecursive(dir: string, maxDepth: number): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      if (entry === "SKILL.md") {
        found.push(full);
        continue;
      }
      try {
        const s = await stat(full);
        if (s.isDirectory()) await walk(full, depth + 1);
      } catch {
        // unreadable — skip
      }
    }
  }
  await walk(dir, 0);
  return found;
}

async function listInstalledSkills(): Promise<SkillDef[]> {
  const roots = [
    join(codexHome(), "skills"), // global skills, e.g. ~/.codex/skills/.system/<name>/SKILL.md
    join(codexHome(), "plugins"), // plugin-provided skills, e.g. plugins/cache/**/skills/<name>/SKILL.md
    resolve(".agents", "skills"), // project-local, per Codex docs
  ];
  const paths = (await Promise.all(roots.map((r) => findSkillMdRecursive(r, 6)))).flat();
  const skills: SkillDef[] = [];
  for (const path of paths) {
    try {
      const content = await readFile(path, "utf-8");
      const meta = parseSkillFrontmatter(content);
      if (meta) skills.push({ ...meta, path });
    } catch {
      // unreadable — skip
    }
  }
  return skills;
}

// ─── Session file discovery ───────────────────────────────────────────────
// ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl

async function listSessionFiles(sessionId?: string): Promise<ProviderSessionFile[]> {
  const root = join(codexHome(), "sessions");
  const files: ProviderSessionFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      if (entry.endsWith(".jsonl")) {
        if (sessionId && !entry.includes(sessionId)) continue;
        try {
          files.push({ path: full, mtimeMs: (await stat(full)).mtimeMs });
        } catch {
          // skip unreadable
        }
        continue;
      }
      try {
        const s = await stat(full);
        if (s.isDirectory()) await walk(full, depth + 1);
      } catch {
        // skip
      }
    }
  }
  await walk(root, 0);
  return files;
}

// ─── Rollout entry types (empirically observed, not a documented schema) ──

interface RolloutEntry {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    id?: string;
    cwd?: string;
    role?: string;
    name?: string;
    arguments?: string;
    input?: string;
    call_id?: string;
    output?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
}

async function* readRolloutFile(filePath: string): AsyncGenerator<RolloutEntry> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as RolloutEntry;
    } catch {
      // skip malformed lines
    }
  }
}

function userMessageText(payload: RolloutEntry["payload"]): string | undefined {
  if (!payload || payload.role !== "user") return undefined;
  return (payload.content ?? [])
    .filter((c) => typeof c?.text === "string")
    .map((c) => c.text)
    .join(" ");
}

/** Does this tool call's raw arguments reference the given skill's SKILL.md path? */
function callReferencesSkill(rawArgs: string | undefined, skill: SkillDef): boolean {
  return typeof rawArgs === "string" && rawArgs.includes(skill.path);
}

async function extractInvocationsFromFile(
  filePath: string,
  skills: SkillDef[],
  opts: ExtractAllOptions
): Promise<SkillInvocationEvent[]> {
  if (skills.length === 0) return [];
  const maxLen = opts.triggerMaxLen ?? 300;
  const capture = opts.captureTriggerMessages ?? true;

  const entries: RolloutEntry[] = [];
  for await (const entry of readRolloutFile(filePath)) entries.push(entry);

  let sessionId = "";
  let cwd: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_meta") {
      sessionId = String(entry.payload?.id ?? "");
      cwd = entry.payload?.cwd;
      break;
    }
  }
  if (!sessionId) return [];

  const events: SkillInvocationEvent[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.type !== "response_item") continue;
    const p = entry.payload;
    if (!p || (p.type !== "function_call" && p.type !== "custom_tool_call")) continue;
    const rawArgs = p.type === "function_call" ? p.arguments : p.input;

    const matchedSkill = skills.find((s) => callReferencesSkill(rawArgs, s));
    if (!matchedSkill) continue;

    // Find the nearest preceding user message for the trigger text.
    let triggerMessage: string | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const prev = entries[j]!;
      if (prev.type !== "response_item") continue;
      const text = userMessageText(prev.payload);
      if (text !== undefined) {
        triggerMessage = text.slice(0, maxLen);
        break;
      }
    }

    // Codex has no structured "user vs auto" flag — infer from an explicit
    // `$SkillName` mention, the documented explicit-invocation syntax.
    const explicitRe = new RegExp(
      `\\$${matchedSkill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`
    );
    const source: InvocationSource = explicitRe.test(triggerMessage ?? "") ? "user" : "claude";

    // Estimate injected tokens from the matching function_call_output, if present nearby.
    let injectedTokens: number | undefined;
    const callId = p.call_id;
    if (callId) {
      for (let j = i + 1; j < Math.min(i + 6, entries.length); j++) {
        const next = entries[j]!;
        if (next.type !== "response_item") continue;
        const np = next.payload;
        if (
          (np?.type === "function_call_output" || np?.type === "custom_tool_call_output") &&
          np.call_id === callId
        ) {
          if (typeof np.output === "string") injectedTokens = estimateTokens(np.output);
          break;
        }
      }
    }

    events.push({
      id: callId ?? `${sessionId}-${i}`,
      timestamp: entry.timestamp ?? new Date().toISOString(),
      sessionId,
      skillName: matchedSkill.name,
      source,
      triggerMessage: capture ? triggerMessage : undefined,
      injectedTokens,
      cwd,
      recordedVia: "scan",
      provider: "codex",
    });
  }

  return events;
}

export const codexProvider: Provider = {
  id: "codex",
  displayName: "Codex CLI",
  confidence: "best-effort",
  supportsHooks: true,
  supportsScan: true,
  listInstalledSkills,
  listSessionFiles,
  extractInvocationsFromFile,
  hookInfo(_project) {
    // Codex hooks are always user-level; there is no documented project-scoped
    // hooks file distinct from config.toml's inline [[hooks.*]] sections.
    return { settingsPath: join(codexHome(), "hooks.json"), format: "json" };
  },
};
