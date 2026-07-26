import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildHtmlReport } from "./web-report.js";
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
    const match = /const EVENTS = (\[[\s\S]*?\]);\n/.exec(html);
    assert.ok(match, "EVENTS array not found in output");
    const parsed = JSON.parse(match![1]!);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].id, "abc");
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
