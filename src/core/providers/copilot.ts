import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSkillFrontmatter } from "./skill-md.js";
import type { Provider, SkillDef } from "./types.js";

/**
 * GitHub Copilot CLI integration (#v3-multi-provider) — best-effort.
 *
 * Doc-researched only (docs.github.com/en/copilot/reference/hooks-reference);
 * no local Copilot CLI install/session data was available to verify against
 * empirically, unlike Codex. Two consequences:
 *
 * - Hook payloads are camelCase and documented, so real-time hook-capture is
 *   implemented (`supportsHooks: true`).
 * - No session/transcript log format is documented anywhere, so retroactive
 *   scanning is NOT supported (`supportsScan: false`, no
 *   `listSessionFiles`/`extractInvocationsFromFile`). Users only get data
 *   going forward, from the moment hooks are installed.
 */

// Read at call time (not module load) so tests and the CLI can override via
// CC_COPILOT_HOME at runtime, mirroring CC_PROJECTS_DIR in ../parser.ts.
function copilotHome(): string {
  return process.env.CC_COPILOT_HOME ?? join(homedir(), ".copilot");
}

async function findSkillMdFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const skillMdPath = join(dir, entry, "SKILL.md");
    try {
      await readFile(skillMdPath, "utf-8");
      found.push(skillMdPath);
    } catch {
      // not every subdirectory is a skill
    }
  }
  return found;
}

async function listInstalledSkills(): Promise<SkillDef[]> {
  const dirs = [
    resolve(".github", "skills"), // repo-level
    join(copilotHome(), "skills"), // personal
  ];
  const skills: SkillDef[] = [];
  for (const dir of dirs) {
    for (const path of await findSkillMdFiles(dir)) {
      try {
        const content = await readFile(path, "utf-8");
        const meta = parseSkillFrontmatter(content);
        if (meta) skills.push({ ...meta, path });
      } catch {
        // unreadable — skip
      }
    }
  }
  return skills;
}

export const copilotProvider: Provider = {
  id: "copilot",
  displayName: "GitHub Copilot CLI",
  confidence: "best-effort",
  supportsHooks: true,
  supportsScan: false,
  listInstalledSkills,
  hookInfo(project) {
    return {
      settingsPath: project ? resolve(".github", "copilot", "settings.json") : join(copilotHome(), "settings.json"),
      format: "json",
    };
  },
};
