import type { ExtractAllOptions } from "../parser.js";
import type { ProviderId, SkillInvocationEvent } from "../types.js";

/** One skill discovered on disk, used to cross-reference tool/function calls against known skills. */
export interface SkillDef {
  /** The skill's canonical name (SKILL.md frontmatter `name:`, falling back to the directory name). */
  name: string;
  description?: string;
  /** Absolute path to the skill's SKILL.md. */
  path: string;
}

/**
 * A discovered session/transcript file for a given provider, mirroring
 * {@link import("../parser.js").SessionFileInfo} but provider-agnostic.
 */
export interface ProviderSessionFile {
  path: string;
  mtimeMs: number;
}

/**
 * Confidence level for a provider's integration, surfaced to users so they
 * know how much to trust what a given provider reports. Codex CLI and GitHub
 * Copilot CLI do not publicly document the exact runtime event shape for a
 * skill invocation (unlike Claude Code's PreToolUse `Skill` tool_use), so
 * those integrations detect invocations by cross-referencing tool/function
 * call names and arguments against the set of skills installed on disk —
 * robust in practice, but not a documented contract (#v3-multi-provider).
 */
export type ProviderConfidence = "stable" | "best-effort";

/** Everything a provider needs to install/verify its hooks. */
export interface ProviderHookInfo {
  /** Absolute path to the settings/hooks file this provider reads. */
  settingsPath: string;
  /** Serialization format of that file. */
  format: "json" | "toml";
}

/**
 * One agent CLI cc-skill-trace can capture skill invocations from.
 * Claude Code is the original, fully-documented integration; Codex CLI and
 * GitHub Copilot CLI are best-effort, built from their public hook schemas
 * and (for Codex) an empirically-inspected session-log format.
 */
export interface Provider {
  id: ProviderId;
  displayName: string;
  confidence: ProviderConfidence;
  /** Whether this provider supports real-time hook-based capture. */
  supportsHooks: boolean;
  /** Whether this provider supports retroactive session-log scanning. */
  supportsScan: boolean;

  /** List skills installed for this provider (global + project-local), for cross-referencing tool calls. */
  listInstalledSkills(): Promise<SkillDef[]>;

  /** List session/transcript files, optionally scoped to one session ID. Only when {@link supportsScan}. */
  listSessionFiles?(sessionId?: string): Promise<ProviderSessionFile[]>;

  /** Extract skill invocations from one session file. Only when {@link supportsScan}. */
  extractInvocationsFromFile?(
    filePath: string,
    skills: SkillDef[],
    opts: ExtractAllOptions
  ): Promise<SkillInvocationEvent[]>;

  /** Where this provider's hook/settings configuration lives, for a given scope. */
  hookInfo(project: boolean): ProviderHookInfo;
}
