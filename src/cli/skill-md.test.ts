import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeSkillMdStale } from "./skill-md.js";

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
});
