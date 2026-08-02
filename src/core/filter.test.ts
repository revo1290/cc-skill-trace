import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyFilter, compileFilter, matchesFilter, parseDuration, resolveDateInput } from "./filter.js";
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

describe("parseDuration (#93)", () => {
  const now = new Date("2026-04-15T12:00:00.000Z");

  it("subtracts minutes (#199)", () => {
    assert.equal(parseDuration("30min", now).toISOString(), "2026-04-15T11:30:00.000Z");
    assert.equal(parseDuration("5mins", now).toISOString(), "2026-04-15T11:55:00.000Z");
  });

  it("subtracts hours", () => {
    assert.equal(parseDuration("12h", now).toISOString(), "2026-04-15T00:00:00.000Z");
  });

  it("subtracts days", () => {
    assert.equal(parseDuration("5d", now).toISOString(), "2026-04-10T12:00:00.000Z");
  });

  it("subtracts weeks", () => {
    assert.equal(parseDuration("2w", now).toISOString(), "2026-04-01T12:00:00.000Z");
  });

  it("subtracts months (m and mo)", () => {
    assert.equal(parseDuration("1mo", now).toISOString(), "2026-03-15T12:00:00.000Z");
    assert.equal(parseDuration("1m", now).toISOString(), "2026-03-15T12:00:00.000Z");
  });

  it("subtracts years", () => {
    assert.equal(parseDuration("1y", now).toISOString(), "2025-04-15T12:00:00.000Z");
  });

  it("throws on unrecognized input", () => {
    assert.throws(() => parseDuration("banana"));
    assert.throws(() => parseDuration(""));
  });
});

describe("resolveDateInput (#159)", () => {
  const now = new Date("2026-04-15T12:00:00.000Z");

  it("passes through ISO dates unchanged", () => {
    assert.equal(resolveDateInput("2026-04-01", now), "2026-04-01");
  });

  it("resolves 'today' to local midnight", () => {
    const iso = resolveDateInput("today", now);
    assert.ok(iso.startsWith("2026-04-15") || iso.startsWith("2026-04-14"));
  });

  it("resolves 'yesterday'", () => {
    const today = new Date(resolveDateInput("today", now));
    const yesterday = new Date(resolveDateInput("yesterday", now));
    assert.equal(today.getTime() - yesterday.getTime(), 24 * 60 * 60 * 1000);
  });

  it("resolves 'N days ago' / 'N weeks ago' / 'N months ago'", () => {
    assert.equal(resolveDateInput("7 days ago", now), parseDuration("7d", now).toISOString());
    assert.equal(resolveDateInput("2 weeks ago", now), parseDuration("2w", now).toISOString());
    assert.equal(resolveDateInput("3 months ago", now), parseDuration("3mo", now).toISOString());
  });

  it("resolves bare durations as 'this long ago'", () => {
    assert.equal(resolveDateInput("30d", now), parseDuration("30d", now).toISOString());
  });

  it("throws on garbage input", () => {
    assert.throws(() => resolveDateInput("not a date", now));
  });
});

describe("compileFilter + matchesFilter (#119)", () => {
  it("matches on since/before/skill/sessionId/source", () => {
    const ev = makeEvent({ timestamp: "2026-02-01T00:00:00.000Z", skillName: "pdf", sessionId: "s1", source: "user" });
    const f = compileFilter({ since: "2026-01-01T00:00:00.000Z", before: "2026-03-01T00:00:00.000Z", skill: "pdf", sessionId: "s1", source: "user" });
    assert.ok(matchesFilter(ev, f));
    assert.ok(!matchesFilter(ev, compileFilter({ skill: "docx" })));
  });

  it("matches cwd as a prefix", () => {
    const ev = makeEvent({ cwd: "/home/user/project/sub" });
    assert.ok(matchesFilter(ev, compileFilter({ cwd: "/home/user/project" })));
    assert.ok(!matchesFilter(ev, compileFilter({ cwd: "/home/other" })));
  });

  it("matches branch exactly", () => {
    const ev = makeEvent({ gitBranch: "feature-x" });
    assert.ok(matchesFilter(ev, compileFilter({ branch: "feature-x" })));
    assert.ok(!matchesFilter(ev, compileFilter({ branch: "main" })));
  });

  it("matches tag membership", () => {
    const ev = makeEvent({ tags: ["false-positive", "reviewed"] });
    assert.ok(matchesFilter(ev, compileFilter({ tag: "reviewed" })));
    assert.ok(!matchesFilter(ev, compileFilter({ tag: "missing" })));
  });

  it("grep matches skillName, skillArgs and triggerMessage case-insensitively (#43)", () => {
    const ev = makeEvent({ skillName: "commit", skillArgs: "--amend", triggerMessage: "please COMMIT this" });
    assert.ok(matchesFilter(ev, compileFilter({ grep: "amend" })));
    assert.ok(matchesFilter(ev, compileFilter({ grep: "commit" })));
    assert.ok(!matchesFilter(ev, compileFilter({ grep: "nonexistent" })));
  });

  it("throws a clear error on invalid regex", () => {
    assert.throws(() => compileFilter({ grep: "(unclosed" }), /Invalid --grep pattern/);
  });

  it("matches provider, treating a missing provider field as claude-code (#v3-multi-provider)", () => {
    const legacy = makeEvent(); // no `provider` field, simulating a pre-v3 event
    const codex = makeEvent({ provider: "codex" });
    assert.ok(matchesFilter(legacy, compileFilter({ provider: "claude-code" })));
    assert.ok(!matchesFilter(legacy, compileFilter({ provider: "codex" })));
    assert.ok(matchesFilter(codex, compileFilter({ provider: "codex" })));
    assert.ok(!matchesFilter(codex, compileFilter({ provider: "claude-code" })));
  });

  it("applyFilter combines multiple criteria with AND semantics", () => {
    const events = [
      makeEvent({ id: "a", skillName: "pdf", source: "user" }),
      makeEvent({ id: "b", skillName: "pdf", source: "claude" }),
      makeEvent({ id: "c", skillName: "docx", source: "user" }),
    ];
    const result = applyFilter(events, { skill: "pdf", source: "user" });
    assert.deepEqual(result.map((e) => e.id), ["a"]);
  });
});
