import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHtmlReport, computeReportData } from "./web-report.js";
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

describe("buildHtmlReport (#60)", () => {
  it("returns a well-formed standalone HTML document for empty input", () => {
    const html = buildHtmlReport([]);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(html.trim().endsWith("</html>"));
    assert.ok(html.includes("<title>"));
  });

  it("embeds event data as valid JSON inside a script tag", () => {
    const events = [makeEvent({ id: "abc" }), makeEvent({ id: "def", skillName: "pdf" })];
    const html = buildHtmlReport(events);
    const match = /let DATA = (\{[\s\S]*?\});\n/.exec(html);
    assert.ok(match, "DATA payload not found in output");
    const parsed = JSON.parse(match![1]!);
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.events[0].id, "abc");
    assert.equal(parsed.stats.total, 2);
  });

  it("escapes '</script>' sequences to prevent premature script termination", () => {
    const events = [makeEvent({ triggerMessage: "</script><script>alert(1)</script>" })];
    const html = buildHtmlReport(events);
    assert.ok(!html.includes("</script><script>alert(1)</script>"));
    assert.ok(html.includes("<\\/script>"));
  });

  it("redacts trigger messages when redactTriggers is set (#108)", () => {
    const events = [makeEvent({ triggerMessage: "sensitive info here" })];
    const html = buildHtmlReport(events, { redactTriggers: true });
    assert.ok(!html.includes("sensitive info here"));
    assert.ok(html.includes("[redacted]"));
  });

  it("does not redact by default", () => {
    const events = [makeEvent({ triggerMessage: "plain trigger text" })];
    const html = buildHtmlReport(events);
    assert.ok(html.includes("plain trigger text"));
  });

  it("sets data-theme according to the theme option (#150)", () => {
    assert.ok(buildHtmlReport([], { theme: "light" }).includes('data-theme="light"'));
    assert.ok(buildHtmlReport([], { theme: "dark" }).includes('data-theme="dark"'));
  });

  it("includes ARIA attributes for accessibility (#174)", () => {
    const html = buildHtmlReport([makeEvent()]);
    assert.ok(html.includes("aria-label"));
    assert.ok(html.includes("aria-pressed"));
  });

  it("includes a print media query (#164)", () => {
    const html = buildHtmlReport([]);
    assert.ok(html.includes("@media print"));
  });

  it("does not throw with a large number of events", () => {
    const events = Array.from({ length: 500 }, (_, i) =>
      makeEvent({ id: `ev-${i}`, skillName: `skill-${i % 10}`, timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z` }));
    assert.doesNotThrow(() => buildHtmlReport(events));
  });
});

describe("computeReportData (#228)", () => {
  it("aggregates stats, top skills, days, heatmap and branches", () => {
    const data = computeReportData([
      makeEvent({ id: "a", skillName: "pdf", source: "claude", gitBranch: "main" }),
      makeEvent({ id: "b", skillName: "pdf", source: "user", gitBranch: "main" }),
      makeEvent({
        id: "c",
        skillName: "xlsx",
        source: "claude",
        timestamp: "2026-01-02T05:00:00.000Z",
      }),
    ]);
    assert.equal(data.stats.total, 3);
    assert.equal(data.stats.uniqueSkills, 2);
    assert.equal(data.stats.activeDays, 2);
    assert.equal(data.stats.autoRate, 67);
    assert.deepEqual(data.topSkills[0], ["pdf", { total: 2, byUser: 1, byClaude: 1 }]);
    assert.deepEqual(
      data.byDay.map((d) => d.day),
      ["2026-01-01", "2026-01-02"]
    );
    assert.deepEqual(data.branches, [["main", 2]]);
    assert.equal(data.heatmap.skills.length, 2);
    assert.equal(data.heatmap.rows[0]?.length, 24);
    assert.ok(!Number.isNaN(Date.parse(data.generatedAt)));
  });

  it("returns an empty-but-valid payload for no events", () => {
    const data = computeReportData([]);
    assert.deepEqual(data.events, []);
    assert.deepEqual(data.stats, { total: 0, autoRate: 0, uniqueSkills: 0, activeDays: 0 });
    assert.deepEqual(data.heatmap, { skills: [], rows: [] });
  });

  it("redacts trigger messages before aggregation, like the report does", () => {
    const data = computeReportData([makeEvent({ triggerMessage: "secret" })], {
      redactTriggers: true,
    });
    assert.equal(data.events[0]?.triggerMessage, "[redacted]");
  });
});

describe("buildHtmlReport live mode (#228)", () => {
  it("stays a static, network-free snapshot by default", () => {
    const html = buildHtmlReport([makeEvent()]);
    assert.ok(html.includes("connect-src 'none'"));
    assert.ok(html.includes("const LIVE = null;"));
    assert.ok(!html.includes('id="livePill"'));
  });

  it("embeds the poll settings and relaxes connect-src when live", () => {
    const html = buildHtmlReport([makeEvent()], {
      live: { pollMs: 1500, signature: "abc123" },
    });
    assert.ok(html.includes("connect-src 'self'"));
    assert.ok(html.includes('id="livePill"'));
    const match = /const LIVE = (\{[\s\S]*?\});\n/.exec(html);
    assert.ok(match, "LIVE settings not found");
    assert.deepEqual(JSON.parse(match![1]!), { pollMs: 1500, signature: "abc123" });
  });
});

describe("report page script integrity", () => {
  // The whole page is one big tagged template literal, so an unescaped
  // backtick or `${` in the client-side code silently produces a broken
  // <script> that fails only in a browser. Parse it here instead.
  for (const [label, opts] of [
    ["static", {}],
    ["live", { live: { pollMs: 1000, signature: "sig" } }],
  ] as const) {
    it(`emits syntactically valid client JavaScript (${label})`, () => {
      const html = buildHtmlReport([makeEvent({ triggerMessage: "back`tick and ${expr}" })], opts);
      const match = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
      assert.ok(match, "inline <script> block not found");
      assert.doesNotThrow(() => new Function(match![1]!));
    });
  }
});
