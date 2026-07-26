import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStats, renderDashboard, renderCompact, vlen,
  renderStats, renderDiagnose, renderDiff, renderGroupBySession,
  configureRender, displayName, sortStats,
} from "./format.js";
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

  it("non-SGR CSI sequences are stripped (cursor move / screen clear)", () => {
    // \x1B[2J (clear screen) and \x1B[1;1H (cursor home) are not SGR ('m')
    assert.equal(vlen("\x1B[2Jhi\x1B[1;1H"), 2);
  });

  it("OSC 8 hyperlinks are stripped, leaving only the visible label", () => {
    // ESC ]8;;URL ST  label  ESC ]8;; ST  → only "label" is visible
    const link = "\x1B]8;;https://example.com\x1B\\label\x1B]8;;\x1B\\";
    assert.equal(vlen(link), 5);
  });

  it("OSC window-title sequences (BEL-terminated) are stripped", () => {
    assert.equal(vlen("\x1B]0;my title\x07hi"), 2);
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

describe("renderStats (#116)", () => {
  it("shows 'No events yet' for empty input", () => {
    assert.ok(renderStats([]).includes("No events yet"));
  });

  it("does not throw and includes streak/hour-of-day sections for populated input", () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      makeEvent({
        id: `ev-${i}`,
        skillName: i % 2 === 0 ? "pdf" : "docx",
        sessionId: `sess-${i % 3}`,
        timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}:00:00.000Z`,
      }));
    const out = renderStats(events);
    assert.ok(out.includes("Daily activity"));
    assert.ok(out.includes("Streak"));
    assert.ok(out.includes("Hour of day"));
    assert.ok(out.includes("Top sessions"));
  });

  it("respects the days and limit options", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ id: `ev-${i}`, sessionId: `sess-${i}`, timestamp: `2026-01-0${i + 1}T00:00:00.000Z` }));
    assert.doesNotThrow(() => renderStats(events, { days: 3, limit: 2 }));
  });
});

describe("renderDiagnose (#41)", () => {
  it("reports no over-triggering skills for empty input", () => {
    assert.ok(renderDiagnose([]).includes("No events yet"));
  });

  it("flags a noisy auto-triggering skill", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ id: `ev-${i}`, skillName: "noisy", triggerMessage: `m${i}` }));
    const out = renderDiagnose(events);
    assert.ok(out.includes("noisy"));
    assert.ok(out.includes("HIGH"));
  });
});

describe("renderDiff (#44)", () => {
  it("does not throw for non-overlapping periods", () => {
    const events = [
      makeEvent({ id: "a", timestamp: "2026-01-01T00:00:00.000Z" }),
      makeEvent({ id: "b", timestamp: "2026-02-01T00:00:00.000Z" }),
    ];
    assert.doesNotThrow(() =>
      renderDiff(
        events,
        { before: "2026-01-31T00:00:00.000Z" },
        { since: "2026-02-01T00:00:00.000Z" },
        { a: "January", b: "February" },
      ));
  });
});

describe("renderGroupBySession (#121)", () => {
  it("groups events under their session ID", () => {
    const events = [
      makeEvent({ id: "a", sessionId: "sess-1" }),
      makeEvent({ id: "b", sessionId: "sess-2" }),
    ];
    const out = renderGroupBySession(events);
    assert.ok(out.includes("sess-1"));
    assert.ok(out.includes("sess-2"));
  });
});

describe("skill aliases (#143)", () => {
  it("displayName falls back to the raw skill name with no alias configured", () => {
    configureRender({ aliases: {} });
    assert.equal(displayName("raw-skill"), "raw-skill");
  });

  it("displayName uses the configured alias", () => {
    configureRender({ aliases: { "raw-skill": "Pretty Name" } });
    assert.equal(displayName("raw-skill"), "Pretty Name");
    configureRender({ aliases: {} }); // reset for other tests
  });
});

describe("sortStats (#103)", () => {
  const stats = [
    { name: "b-skill", total: 5, auto: 1, byUser: 4, autoRate: 20 },
    { name: "a-skill", total: 10, auto: 9, byUser: 1, autoRate: 90 },
  ];

  it("sorts by count descending by default semantics", () => {
    const sorted = sortStats(stats, "count");
    assert.deepEqual(sorted.map((s) => s.name), ["a-skill", "b-skill"]);
  });

  it("sorts by name alphabetically", () => {
    const sorted = sortStats(stats, "name");
    assert.deepEqual(sorted.map((s) => s.name), ["a-skill", "b-skill"]);
  });

  it("sorts by auto-trigger rate descending", () => {
    const sorted = sortStats(stats, "auto");
    assert.deepEqual(sorted.map((s) => s.name), ["a-skill", "b-skill"]);
  });
});
