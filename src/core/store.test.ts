import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, clearEvents, pruneEvents } from "./store.js";
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

describe("store", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "cc-skill-trace-store-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("readEvents", () => {
    it("returns empty array when file does not exist", async () => {
      const events = await readEvents(dir + "-nonexistent");
      assert.deepEqual(events, []);
    });

    it("filters by since/before at read time (#18)", async () => {
      const filterDir = dir + "-filter";
      await appendEvent(makeEvent({ id: "old", timestamp: "2020-01-01T00:00:00.000Z" }), filterDir);
      await appendEvent(makeEvent({ id: "mid", timestamp: "2023-06-01T00:00:00.000Z" }), filterDir);
      await appendEvent(makeEvent({ id: "new", timestamp: "2026-01-01T00:00:00.000Z" }), filterDir);
      const recent = await readEvents({ dir: filterDir, since: "2023-01-01T00:00:00.000Z" });
      assert.deepEqual(recent.map(e => e.id), ["mid", "new"]);
      const range = await readEvents({ dir: filterDir, since: "2023-01-01T00:00:00.000Z", before: "2024-01-01T00:00:00.000Z" });
      assert.deepEqual(range.map(e => e.id), ["mid"]);
    });

    it("respects limit option returning most recent events (#18)", async () => {
      const limitDir = dir + "-limit";
      for (let i = 1; i <= 5; i++) {
        await appendEvent(makeEvent({ id: `ev-${i}`, timestamp: `2026-01-0${i}T00:00:00.000Z` }), limitDir);
      }
      const events = await readEvents({ dir: limitDir, limit: 3 });
      assert.equal(events.length, 3);
      assert.deepEqual(events.map(e => e.id), ["ev-3", "ev-4", "ev-5"]);
    });
  });

  describe("appendEvent + readEvents", () => {
    beforeEach(async () => {
      await clearEvents(dir);
    });

    it("round-trips a single event", async () => {
      const ev = makeEvent({ id: "abc-123", skillName: "pdf" });
      await appendEvent(ev, dir);
      const events = await readEvents(dir);
      assert.equal(events.length, 1);
      assert.equal(events[0].id, "abc-123");
      assert.equal(events[0].skillName, "pdf");
    });

    it("preserves insertion order across multiple events", async () => {
      await appendEvent(makeEvent({ id: "first" }), dir);
      await appendEvent(makeEvent({ id: "second" }), dir);
      await appendEvent(makeEvent({ id: "third" }), dir);
      const events = await readEvents(dir);
      assert.equal(events.length, 3);
      assert.deepEqual(events.map((e) => e.id), ["first", "second", "third"]);
    });

    it("skips malformed lines without losing valid events", async () => {
      await appendEvent(makeEvent({ id: "good-1" }), dir);
      // inject a malformed line directly
      await appendFile(join(dir, "events.jsonl"), "NOT_VALID_JSON\n", "utf-8");
      await appendEvent(makeEvent({ id: "good-2" }), dir);

      const events = await readEvents(dir);
      assert.equal(events.length, 2);
      assert.equal(events[0].id, "good-1");
      assert.equal(events[1].id, "good-2");
    });
  });

  describe("clearEvents", () => {
    it("empties the store", async () => {
      await appendEvent(makeEvent(), dir);
      await clearEvents(dir);
      const events = await readEvents(dir);
      assert.deepEqual(events, []);
    });

    it("is idempotent on an already-empty store", async () => {
      await clearEvents(dir);
      await clearEvents(dir);
      const events = await readEvents(dir);
      assert.deepEqual(events, []);
    });
  });

  describe("pruneEvents", () => {
    beforeEach(async () => {
      await clearEvents(dir);
    });

    it("removes events older than the cutoff and keeps newer ones", async () => {
      await appendEvent(makeEvent({ id: "old-1", timestamp: "2020-01-01T00:00:00.000Z" }), dir);
      await appendEvent(makeEvent({ id: "old-2", timestamp: "2020-06-15T00:00:00.000Z" }), dir);
      await appendEvent(makeEvent({ id: "new-1", timestamp: "2026-01-01T00:00:00.000Z" }), dir);
      await appendEvent(makeEvent({ id: "new-2", timestamp: "2026-04-01T00:00:00.000Z" }), dir);

      const result = await pruneEvents("2025-01-01T00:00:00.000Z", dir);
      assert.equal(result.removed, 2);
      assert.equal(result.kept, 2);

      const remaining = await readEvents(dir);
      assert.equal(remaining.length, 2);
      assert.deepEqual(remaining.map(e => e.id), ["new-1", "new-2"]);
    });

    it("returns zero removed when all events are newer than cutoff", async () => {
      await appendEvent(makeEvent({ id: "a", timestamp: "2026-04-01T00:00:00.000Z" }), dir);
      const result = await pruneEvents("2020-01-01T00:00:00.000Z", dir);
      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1);
    });

    it("removes all events when all are older than cutoff", async () => {
      await appendEvent(makeEvent({ id: "x", timestamp: "2020-01-01T00:00:00.000Z" }), dir);
      const result = await pruneEvents("2026-01-01T00:00:00.000Z", dir);
      assert.equal(result.removed, 1);
      assert.equal(result.kept, 0);
      const remaining = await readEvents(dir);
      assert.deepEqual(remaining, []);
    });
  });
});
