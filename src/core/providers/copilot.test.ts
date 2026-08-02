import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { copilotProvider } from "./copilot.js";

describe("copilotProvider", () => {
  let home: string;
  const prevHome = process.env["CC_COPILOT_HOME"];

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "cc-skill-trace-copilot-test-"));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env["CC_COPILOT_HOME"];
    else process.env["CC_COPILOT_HOME"] = prevHome;
  });

  beforeEach(() => {
    process.env["CC_COPILOT_HOME"] = home;
  });

  it("does not support scanning session logs", () => {
    assert.equal(copilotProvider.supportsScan, false);
    assert.equal(copilotProvider.listSessionFiles, undefined);
    assert.equal(copilotProvider.extractInvocationsFromFile, undefined);
  });

  it("supports hook-based capture", () => {
    assert.equal(copilotProvider.supportsHooks, true);
    assert.equal(copilotProvider.confidence, "best-effort");
  });

  it("finds skills under ~/.copilot/skills (personal)", async () => {
    const skillDir = join(home, "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: pdf\ndescription: Extract PDF text\n---\n");

    const skills = await copilotProvider.listInstalledSkills();
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "pdf");
    assert.equal(skills[0]!.path, join(skillDir, "SKILL.md"));
  });

  it("returns an empty array when no skills directories exist", async () => {
    process.env["CC_COPILOT_HOME"] = join(home, "does-not-exist");
    assert.deepEqual(await copilotProvider.listInstalledSkills(), []);
  });

  describe("hookInfo", () => {
    it("resolves the personal settings.json for global scope", () => {
      assert.equal(copilotProvider.hookInfo(false).settingsPath, join(home, "settings.json"));
      assert.equal(copilotProvider.hookInfo(false).format, "json");
    });

    it("resolves .github/copilot/settings.json for project scope", () => {
      assert.equal(copilotProvider.hookInfo(true).settingsPath, resolve(".github", "copilot", "settings.json"));
    });
  });
});
