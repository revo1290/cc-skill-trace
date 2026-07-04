import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isCcSkillTraceHook, CC_HOOK_COMMAND } from "./hooks.js";

describe("isCcSkillTraceHook", () => {
  it("matches the hook entry install registers", () => {
    const entry = {
      matcher: "Skill",
      hooks: [{ type: "command", command: CC_HOOK_COMMAND }],
    };
    assert.equal(isCcSkillTraceHook(entry), true);
  });

  it("matches when the command is wrapped (e.g. absolute path or npx)", () => {
    const entry = {
      matcher: "Skill",
      hooks: [{ type: "command", command: "npx cc-skill-trace hook-capture" }],
    };
    assert.equal(isCcSkillTraceHook(entry), true);
  });

  it("does NOT match an unrelated hook that only mentions cc-skill-trace in a field", () => {
    // Regression for #187: JSON.stringify(h).includes("cc-skill-trace") wrongly
    // matched this because the string appears in the description, not the command.
    const entry = {
      matcher: "Bash",
      description: "Used alongside cc-skill-trace for debugging",
      hooks: [{ type: "command", command: "my-other-tool" }],
    };
    assert.equal(isCcSkillTraceHook(entry), false);
  });

  it("does not match an unrelated hook with no cc-skill-trace reference", () => {
    const entry = {
      matcher: "Skill",
      hooks: [{ type: "command", command: "some-other-capture-tool" }],
    };
    assert.equal(isCcSkillTraceHook(entry), false);
  });

  it("is safe on malformed / non-object entries", () => {
    assert.equal(isCcSkillTraceHook(null), false);
    assert.equal(isCcSkillTraceHook(undefined), false);
    assert.equal(isCcSkillTraceHook("cc-skill-trace hook-capture"), false);
    assert.equal(isCcSkillTraceHook({}), false);
    assert.equal(isCcSkillTraceHook({ hooks: "not-an-array" }), false);
    assert.equal(isCcSkillTraceHook({ hooks: [null, 42, {}] }), false);
  });
});
