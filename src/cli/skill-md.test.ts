import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeSkillMd, skillMdChanged } from "./skill-md.js";

test("normalizeSkillMd converts CRLF to LF", () => {
  assert.equal(normalizeSkillMd("a\r\nb\r\nc"), "a\nb\nc");
});

test("normalizeSkillMd converts lone CR to LF", () => {
  assert.equal(normalizeSkillMd("a\rb"), "a\nb");
});

test("normalizeSkillMd leaves LF-only content unchanged", () => {
  assert.equal(normalizeSkillMd("a\nb\nc"), "a\nb\nc");
});

test("skillMdChanged treats CRLF and LF versions as equal (#181)", () => {
  const lf = "# Skill\nline 1\nline 2\n";
  const crlf = "# Skill\r\nline 1\r\nline 2\r\n";
  assert.equal(skillMdChanged(crlf, lf), false);
  assert.equal(skillMdChanged(lf, lf), false);
});

test("skillMdChanged detects real content differences", () => {
  const a = "# Skill\nold\n";
  const b = "# Skill\nnew\n";
  assert.equal(skillMdChanged(a, b), true);
});
