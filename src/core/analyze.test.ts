import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeAutoTriggers, computeStreaks, diffPeriods, estimateCost,
  estimateTokens, groupByCwd, hourHistogram,
} from "./analyze.js";
import type { SkillInvocationEvent } from "./types.js";

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

describe("estimateTokens (#123)", () => {
  it("estimates roughly 4 chars/token for ASCII", () => {
    const t = estimateTokens("a".repeat(400));
    assert.ok(t >= 90 && t <= 110, `expected ~100, got ${t}`);
  });

  it("estimates roughly 1.5 chars/token for CJK", () => {
    const t = estimateTokens("あ".repeat(150));
    assert.ok(t >= 90 && t <= 110, `expected ~100, got ${t}`);
  });

  it("handles empty string", () => {
    assert.equal(estimateTokens(""), 0);
  });

  it("mixed ASCII+CJK sums both contributions", () => {
    const ascii = estimateTokens("a".repeat(400));
    const cjk = estimateTokens("あ".repeat(150));
    assert.equal(estimateTokens(`${"a".repeat(400)}${"あ".repeat(150)}`), ascii + cjk);
  });
});

describe("analyzeAutoTriggers (#41)", () => {
  it("flags a skill with a high auto-trigger rate as high severity", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      makeEvent({ id: `ev-${i}`, skillName: "noisy", source: "claude", triggerMessage: `msg ${i}` }));
    const [finding] = analyzeAutoTriggers(events);
    assert.equal(finding.skillName, "noisy");
    assert.equal(finding.severity, "high");
    assert.ok(finding.suggestions.length > 0);
  });

  it("leaves a mostly-user-invoked skill as low severity", () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({ id: `ev-${i}`, skillName: "explicit", source: "user" }));
    const [finding] = analyzeAutoTriggers(events);
    assert.equal(finding.severity, "low");
  });

  it("detects burst sessions (3+ auto-fires in one session)", () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      makeEvent({ id: `ev-${i}`, skillName: "bursty", source: "claude", sessionId: "sess-x" }));
    const [finding] = analyzeAutoTriggers(events);
    assert.deepEqual(finding.burstSessions, ["sess-x"]);
  });

  it("sorts high severity before low", () => {
    const events = [
      ...Array.from({ length: 2 }, (_, i) => makeEvent({ id: `low-${i}`, skillName: "calm", source: "user" })),
      ...Array.from({ length: 10 }, (_, i) => makeEvent({ id: `high-${i}`, skillName: "loud", source: "claude", triggerMessage: `m${i}` })),
    ];
    const findings = analyzeAutoTriggers(events);
    assert.equal(findings[0]!.skillName, "loud");
  });
});

describe("diffPeriods (#44)", () => {
  it("computes per-skill deltas between two periods", () => {
    const events = [
      makeEvent({ id: "a1", skillName: "pdf", timestamp: "2026-01-05T00:00:00.000Z" }),
      makeEvent({ id: "b1", skillName: "pdf", timestamp: "2026-02-05T00:00:00.000Z" }),
      makeEvent({ id: "b2", skillName: "pdf", timestamp: "2026-02-06T00:00:00.000Z" }),
    ];
    const rows = diffPeriods(
      events,
      { since: "2026-01-01T00:00:00.000Z", before: "2026-01-31T00:00:00.000Z" },
      { since: "2026-02-01T00:00:00.000Z", before: "2026-02-28T00:00:00.000Z" },
    );
    const pdf = rows.find((r) => r.skillName === "pdf")!;
    assert.equal(pdf.countA, 1);
    assert.equal(pdf.countB, 2);
    assert.equal(pdf.delta, 1);
  });

  it("sorts by absolute delta descending", () => {
    // periodA (January) has zero events for either skill; periodB (February)
    // has 1 "small" and 3 "big" — deltas are +1 and +3 respectively.
    const events = [
      makeEvent({ id: "1", skillName: "small", timestamp: "2026-02-01T00:00:00.000Z" }),
      makeEvent({ id: "2", skillName: "big", timestamp: "2026-02-01T00:00:00.000Z" }),
      makeEvent({ id: "3", skillName: "big", timestamp: "2026-02-02T00:00:00.000Z" }),
      makeEvent({ id: "4", skillName: "big", timestamp: "2026-02-03T00:00:00.000Z" }),
    ];
    const rows = diffPeriods(
      events,
      { before: "2026-01-31T23:59:59.999Z" },
      { since: "2026-02-01T00:00:00.000Z" },
    );
    assert.equal(rows[0]!.skillName, "big");
  });
});

describe("hourHistogram (#160)", () => {
  it("returns 24 buckets summing to the event count", () => {
    const events = [
      makeEvent({ timestamp: "2026-01-01T09:00:00.000Z" }),
      makeEvent({ timestamp: "2026-01-01T09:30:00.000Z" }),
      makeEvent({ timestamp: "2026-01-01T14:00:00.000Z" }),
    ];
    const hist = hourHistogram(events);
    assert.equal(hist.length, 24);
    assert.equal(hist.reduce((a, b) => a + b, 0), 3);
  });
});

describe("computeStreaks (#166)", () => {
  it("computes current and longest streaks anchored on 'today'", () => {
    const today = new Date("2026-04-15T12:00:00.000Z");
    const events = [
      makeEvent({ timestamp: "2026-04-13T10:00:00.000Z" }),
      makeEvent({ timestamp: "2026-04-14T10:00:00.000Z" }),
      makeEvent({ timestamp: "2026-04-15T10:00:00.000Z" }),
    ];
    const { current, longest } = computeStreaks(events, today);
    assert.equal(current, 3);
    assert.equal(longest, 3);
  });

  it("returns zero streak when there is a gap before today", () => {
    const today = new Date("2026-04-15T12:00:00.000Z");
    const events = [makeEvent({ timestamp: "2026-04-10T10:00:00.000Z" })];
    const { current } = computeStreaks(events, today);
    assert.equal(current, 0);
  });

  it("returns zeros for no events", () => {
    assert.deepEqual(computeStreaks([]), { current: 0, longest: 0 });
  });
});

describe("groupByCwd (#135)", () => {
  it("aggregates totals and auto counts per working directory", () => {
    const events = [
      makeEvent({ cwd: "/repo-a", source: "claude" }),
      makeEvent({ cwd: "/repo-a", source: "user" }),
      makeEvent({ cwd: "/repo-b", source: "claude" }),
    ];
    const stats = groupByCwd(events);
    const a = stats.find((s) => s.cwd === "/repo-a")!;
    assert.equal(a.total, 2);
    assert.equal(a.auto, 1);
  });

  it("buckets events without cwd as (unknown)", () => {
    const stats = groupByCwd([makeEvent({ cwd: undefined })]);
    assert.equal(stats[0]!.cwd, "(unknown)");
  });
});

describe("estimateCost (#49)", () => {
  it("returns zero cost when no events have injectedTokens", () => {
    const result = estimateCost([makeEvent()]);
    assert.equal(result.measuredEvents, 0);
    assert.equal(result.estimatedUSD, 0);
  });

  it("sums tokens and computes USD proportional to model price", () => {
    const events = [
      makeEvent({ skillName: "pdf", injectedTokens: 1_000_000 }),
      makeEvent({ skillName: "docx", injectedTokens: 1_000_000 }),
    ];
    const sonnet = estimateCost(events, "sonnet");
    const opus = estimateCost(events, "opus");
    assert.equal(sonnet.totalInjectedTokens, 2_000_000);
    assert.ok(opus.estimatedUSD > sonnet.estimatedUSD);
  });
});
