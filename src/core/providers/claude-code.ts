import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { extractInvocationsFromFile, listSessionFiles } from "../parser.js";
import { parseSkillFrontmatter } from "./skill-md.js";
import type { Provider, SkillDef } from "./types.js";

/** Directories that may contain SKILL.md files: global + project-local. */
async function skillDirs(): Promise<string[]> {
  return [join(homedir(), ".claude", "skills"), resolve(".claude", "skills")];
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
  const skills: SkillDef[] = [];
  for (const dir of await skillDirs()) {
    for (const path of await findSkillMdFiles(dir)) {
      try {
        const content = await readFile(path, "utf-8");
        const meta = parseSkillFrontmatter(content);
        if (meta) skills.push({ ...meta, path });
      } catch {
        // unreadable skill file — skip
      }
    }
  }
  return skills;
}

export const claudeCodeProvider: Provider = {
  id: "claude-code",
  displayName: "Claude Code",
  confidence: "stable",
  supportsHooks: true,
  supportsScan: true,
  listInstalledSkills,
  listSessionFiles: (sessionId) => listSessionFiles(sessionId),
  extractInvocationsFromFile: (filePath, _skills, opts) => extractInvocationsFromFile(filePath, opts),
  hookInfo(project) {
    return {
      settingsPath: project ? resolve(".claude/settings.json") : join(homedir(), ".claude", "settings.json"),
      format: "json",
    };
  },
};
