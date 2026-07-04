import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - plain .mjs build helper, no type declarations
import { copySkillMd } from "../../scripts/copy-skill.mjs";

// Regression test for #183: `tsc` never copies .md assets, so the build must
// place src/skill/SKILL.md at dist/skill/SKILL.md or `install` fails with
// "Skill file not found".
describe("copySkillMd (#183)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-skill-trace-copy-test-"));
    await mkdir(join(root, "src", "skill"), { recursive: true });
    await writeFile(join(root, "src", "skill", "SKILL.md"), "# SKILL\ncontent\n", "utf-8");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates dist/skill/SKILL.md with identical content", async () => {
    const dest = await copySkillMd(root);
    assert.equal(dest, join(root, "dist", "skill", "SKILL.md"));
    await access(dest); // throws if the file was not created
    const copied = await readFile(dest, "utf-8");
    const original = await readFile(join(root, "src", "skill", "SKILL.md"), "utf-8");
    assert.equal(copied, original);
  });

  it("creates the dist/skill directory when it does not exist yet", async () => {
    await assert.rejects(access(join(root, "dist", "skill")));
    await copySkillMd(root);
    await access(join(root, "dist", "skill"));
  });
});
