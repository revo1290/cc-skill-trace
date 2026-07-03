import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandTilde } from "./utils.js";

describe("expandTilde", () => {
  it("expands a bare ~ to the home directory", () => {
    assert.equal(expandTilde("~"), homedir());
  });

  it("expands ~/path to a path under the home directory", () => {
    assert.equal(expandTilde("~/my-claude-projects"), join(homedir(), "my-claude-projects"));
  });

  it("expands a Windows-style ~\\path", () => {
    assert.equal(expandTilde("~\\projects"), join(homedir(), "projects"));
  });

  it("leaves absolute paths untouched", () => {
    assert.equal(expandTilde("/tmp/projects"), "/tmp/projects");
  });

  it("leaves relative paths untouched", () => {
    assert.equal(expandTilde("projects/foo"), "projects/foo");
  });

  it("does not expand ~ that is not a leading path segment", () => {
    assert.equal(expandTilde("/opt/~backup"), "/opt/~backup");
  });

  it("does not expand the ~user form", () => {
    assert.equal(expandTilde("~alice/projects"), "~alice/projects");
  });
});
