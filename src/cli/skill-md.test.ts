import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSkillMd, skillMdChanged, computeSkillMdStale } from "./skill-md.js";

describe("computeSkillMdStale", () => {
  it("is stale when installed content differs from bundled", () => {
    assert.deepEqual(
      computeSkillMdStale({ ok: true, content: "v2" }, { ok: true, content: "v1" }),
      { stale: true, bundledMissing: false }
    );
  });

  it("is not stale when installed content matches bundled", () => {
    assert.deepEqual(
      computeSkillMdStale({ ok: true, content: "same" }, { ok: true, content: "same" }),
      { stale: false, bundledMissing: false }
    );
  });

  it("is not stale (and not a build problem) when nothing is installed yet", () => {
    assert.deepEqual(computeSkillMdStale({ ok: true, content: "v1" }, { ok: false }), {
      stale: false,
      bundledMissing: false,
    });
  });

  it("flags bundledMissing when the bundled SKILL.md cannot be read (#190)", () => {
    // Regression: previously any read failure was swallowed as "up to date",
    // hiding a broken build. The bundled-missing case must be distinguishable.
    assert.deepEqual(computeSkillMdStale({ ok: false }, { ok: true, content: "v1" }), {
      stale: false,
      bundledMissing: true,
    });
  });

  it("flags bundledMissing even when installed is also unreadable", () => {
    assert.deepEqual(computeSkillMdStale({ ok: false }, { ok: false }), {
      stale: false,
      bundledMissing: true,
    });
  });

  it("ignores line-ending differences when deciding staleness (#181 + #190)", () => {
    // The staleness check must stay line-ending agnostic so a CRLF checkout of
    // the bundled file is not reported stale forever.
    assert.deepEqual(
      computeSkillMdStale(
        { ok: true, content: "# Skill\r\nline 1\r\n" },
        { ok: true, content: "# Skill\nline 1\n" }
      ),
      { stale: false, bundledMissing: false }
    );
  });
});

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
