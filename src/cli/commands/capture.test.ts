import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { valueContainsPath } from "./capture.js";

describe("valueContainsPath (#v3-multi-provider)", () => {
  it("matches a path inside a plain string value", () => {
    assert.ok(valueContainsPath({ command: "cat /repo/skills/pdf/SKILL.md" }, "/repo/skills/pdf/SKILL.md"));
  });

  it("does not match an unrelated string", () => {
    assert.ok(!valueContainsPath({ command: "ls -la" }, "/repo/skills/pdf/SKILL.md"));
  });

  it("searches nested objects and arrays", () => {
    const value = { args: ["ls", { file: "/repo/skills/pdf/SKILL.md" }] };
    assert.ok(valueContainsPath(value, "/repo/skills/pdf/SKILL.md"));
  });

  it("matches a Windows-style backslash path without re-escaping it (regression, cross-platform)", () => {
    // The bug this guards against: JSON.stringify(value).includes(path) would double-escape
    // `\` to `\\` when re-serializing an already-decoded value, so a raw filesystem path
    // (single backslashes) would never match on Windows. valueContainsPath walks the
    // decoded value directly instead, so both sides stay at the same (zero) escaping level.
    const path = "C:\\Users\\alice\\.copilot\\skills\\pdf\\SKILL.md";
    const value = { command: `type ${path}` };
    assert.ok(valueContainsPath(value, path));
  });

  it("returns false for non-string, non-object, non-array leaves", () => {
    assert.ok(!valueContainsPath(42, "anything"));
    assert.ok(!valueContainsPath(null, "anything"));
    assert.ok(!valueContainsPath(undefined, "anything"));
  });
});
