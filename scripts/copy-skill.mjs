// Copies the bundled SKILL.md into dist/ after `tsc`, because tsc only emits
// .js/.d.ts and never copies .md assets. Without this step dist/skill/SKILL.md
// is missing and `cc-skill-trace install` prints "Skill file not found" even
// after a successful `npm install`. (#183)
//
// Kept as a plain cross-platform Node script (no `cp`) so the build works on
// Windows CI as well as macOS/Linux.

import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Copy src/skill/SKILL.md → dist/skill/SKILL.md under the given project root.
 * Returns the destination path.
 */
export async function copySkillMd(rootDir) {
  const root = rootDir ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const src = join(root, "src", "skill", "SKILL.md");
  const destDir = join(root, "dist", "skill");
  const dest = join(destDir, "SKILL.md");
  await mkdir(destDir, { recursive: true });
  await copyFile(src, dest);
  return dest;
}

// Run the copy when invoked directly (i.e. `node scripts/copy-skill.mjs`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  copySkillMd().catch((err) => {
    console.error(`copy-skill: failed to copy SKILL.md — ${err.message}`);
    process.exit(1);
  });
}
