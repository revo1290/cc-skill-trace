import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildStats, renderDashboard, renderCompact, vlen } from "./format.js";
import type { SkillInvocationEvent } from "../core/types.js";

function makeEvent(overrides: Partial<SkillInvocationEvent> = {}): SkillInvocationEvent {
  return {
    id: "test-id",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "session-1",
    skillName: "test-skill",
    source: "claude",
    ...overrides,
  };
}

describe("buildStats", () => {
  it("returns empty array for no events", () => {
    assert.deepEqual(buildStats([]), []);
  });

  it("counts auto and user invocations separately", () => {
    const events = [
      makeEvent({ skillName: "pdf", source: "claude" }),
      makeEvent({ skillName: "pdf", source: "claude" }),
      makeEvent({ skillName: "pdf", source: "user" }),
      makeEvent({ skillName: "docx", source: "user" }),
    ];
    const stats = buildStats(events);
    const pdf = stats.find((s) => s.name === "pdf")!;
    assert.ok(pdf, "pdf stat missing");
    assert.equal(pdf.total, 3);
    assert.equal(pdf.auto, 2);
    assert.equal(pdf.byUser, 1);
    const docx = stats.find((s) => s.name === "docx")!;
    assert.equal(docx.total, 1);
    assert.equal(docx.byUser, 1);
    assert.equal(docx.auto, 0);
  });

  it("sorts by total count descending", () => {
    const events = [
      makeEvent({ skillName: "rare" }),
      makeEvent({ skillName: "common" }),
      makeEvent({ skillName: "common" }),
      makeEvent({ skillName: "common" }),
    ];
    const [first, second] = buildStats(events);
    assert.equal(first.name, "common");
    assert.equal(second.name, "rare");
  });
});

describe("renderDashboard", () => {
  it("returns a non-empty string", () => {
    const out = renderDashboard([makeEvent()]);
    assert.ok(typeof out === "string" && out.length > 0);
  });

  it("shows 'No events yet' for empty input", () => {
    const out = renderDashboard([]);
    assert.ok(out.includes("No events yet"));
  });

  it("does not throw with many events including unicode skill names", () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ skillName: `スキル${i}`, source: i % 2 === 0 ? "claude" : "user" })
    );
    assert.doesNotThrow(() => renderDashboard(events));
  });

  it("does not throw when all events belong to the same skill (bar overflow edge case)", () => {
    const events = Array.from({ length: 50 }, () =>
      makeEvent({ skillName: "only-skill", source: "claude" })
    );
    assert.doesNotThrow(() => renderDashboard(events));
  });
});

describe("vlen", () => {
  it("ASCII string counts 1 per char", () => {
    assert.equal(vlen("hello"), 5);
  });

  it("CJK character counts 2", () => {
    assert.equal(vlen("日"), 2);
    assert.equal(vlen("日本語"), 6);
  });

  it("plain emoji counts 2", () => {
    assert.equal(vlen("🎉"), 2);
  });

  it("ZWJ sequence counts as 2 (single grapheme)", () => {
    // 👨‍👩‍👧 is man+ZWJ+woman+ZWJ+girl — one grapheme cluster, 2 cols
    assert.equal(vlen("👨‍👩‍👧"), 2);
  });

  it("keycap sequence counts as 2", () => {
    // 1️⃣ is '1' + VS16 (FE0F) + combining enclosing keycap (20E3)
    assert.equal(vlen("1️⃣"), 2);
  });

  it("VS16 text-to-emoji counts as 2", () => {
    // ©️ is copyright sign + VS16
    assert.equal(vlen("©️"), 2);
  });

  it("ANSI escape codes are stripped before measuring", () => {
    const colored = "\x1B[32mhi\x1B[0m";
    assert.equal(vlen(colored), 2);
  });

  it("mixed ASCII and wide chars", () => {
    assert.equal(vlen("A日B"), 4); // 1 + 2 + 1
  });
});

describe("renderCompact", () => {
  it("returns a string with one row per event", () => {
    const events = [
      makeEvent({ skillName: "pdf" }),
      makeEvent({ skillName: "docx" }),
    ];
    const out = renderCompact(events);
    assert.ok(out.includes("pdf"));
    assert.ok(out.includes("docx"));
  });
});
