import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { appendEvent, readEvents, clearEvents, pruneEvents, backupEvents, pendingWriteQueueCount, checkStoreIntegrity, fixStore } from "./store.js";
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

  describe("write queue lifecycle (#169)", () => {
    it("releases the Map entry once writes to a dir have drained", async () => {
      const qDir = dir + "-queue-release";
      await appendEvent(makeEvent({ id: "q1" }), qDir);
      await appendEvent(makeEvent({ id: "q2" }), qDir);
      // Allow the trailing .finally cleanup (a microtask past settlement) to run.
      await Promise.resolve();
      await new Promise((r) => setImmediate(r));
      assert.equal(pendingWriteQueueCount(), 0);
    });

    it("does not leak an entry per distinct dir", async () => {
      const dirs = Array.from({ length: 20 }, (_, i) => `${dir}-leak-${i}`);
      await Promise.all(dirs.map((d) => appendEvent(makeEvent({ id: "x" }), d)));
      await new Promise((r) => setImmediate(r));
      assert.equal(pendingWriteQueueCount(), 0);
    });

    it("still serializes concurrent writes to the same dir in order", async () => {
      const sDir = dir + "-serialize";
      await clearEvents(sDir);
      // Fire many appends without awaiting between them — they must not interleave.
      await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          appendEvent(makeEvent({ id: `s-${i}`, timestamp: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z` }), sDir)
        )
      );
      const events = await readEvents(sDir);
      assert.equal(events.length, 25);
      // Every line parsed cleanly and all 25 ids are present (no torn/interleaved writes).
      assert.deepEqual(
        [...events.map((e) => e.id)].sort(),
        Array.from({ length: 25 }, (_, i) => `s-${i}`).sort()
      );
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

  describe("backupEvents (#180)", () => {
    it("returns null backupPath when there is no store file", async () => {
      const bDir = dir + "-backup-none";
      const result = await backupEvents(bDir);
      assert.equal(result.backupPath, null);
      assert.equal(result.rotatedTo, null);
    });

    it("copies events.jsonl to events.jsonl.bak", async () => {
      const bDir = dir + "-backup-basic";
      await appendEvent(makeEvent({ id: "keep-1" }), bDir);
      await appendEvent(makeEvent({ id: "keep-2" }), bDir);

      const result = await backupEvents(bDir);
      assert.equal(result.backupPath, join(bDir, "events.jsonl.bak"));
      assert.equal(result.rotatedTo, null);

      const original = await readFile(join(bDir, "events.jsonl"), "utf-8");
      const backup = await readFile(join(bDir, "events.jsonl.bak"), "utf-8");
      assert.equal(backup, original);
    });

    it("preserves the store contents even after a subsequent clear", async () => {
      const bDir = dir + "-backup-then-clear";
      await appendEvent(makeEvent({ id: "history" }), bDir);

      await backupEvents(bDir);
      await clearEvents(bDir);

      // Store is empty, but the backup still holds the original event.
      assert.deepEqual(await readEvents(bDir), []);
      const backup = await readFile(join(bDir, "events.jsonl.bak"), "utf-8");
      assert.match(backup, /"id":"history"/);
    });

    it("rotates an existing backup to .bak.bak instead of overwriting it", async () => {
      const bDir = dir + "-backup-rotate";
      await appendEvent(makeEvent({ id: "gen-1" }), bDir);
      const first = await backupEvents(bDir);
      assert.equal(first.rotatedTo, null);

      // New state, second backup should rotate the previous one.
      await appendEvent(makeEvent({ id: "gen-2" }), bDir);
      const second = await backupEvents(bDir);
      assert.equal(second.rotatedTo, join(bDir, "events.jsonl.bak.bak"));

      const rotated = await readFile(join(bDir, "events.jsonl.bak.bak"), "utf-8");
      assert.match(rotated, /"id":"gen-1"/);
      assert.doesNotMatch(rotated, /"id":"gen-2"/);

      const current = await readFile(join(bDir, "events.jsonl.bak"), "utf-8");
      assert.match(current, /"id":"gen-2"/);
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

  describe("checkStoreIntegrity (#175)", () => {
    it("reports zero bad lines for a clean store", async () => {
      const d = dir + "-integrity-clean";
      await appendEvent(makeEvent({ id: "v1" }), d);
      await appendEvent(makeEvent({ id: "v2" }), d);

      const r = await checkStoreIntegrity(d);
      assert.equal(r.storePath, join(d, "events.jsonl"));
      assert.equal(r.totalLines, 2);
      assert.equal(r.validEvents, 2);
      assert.equal(r.malformedLines, 0);
      assert.equal(r.truncatedLines, 0);
      assert.equal(r.tmpLeftover, null);
    });

    it("classifies malformed vs truncated lines", async () => {
      const d = dir + "-integrity-bad";
      await appendEvent(makeEvent({ id: "v1" }), d);
      // Structurally complete (ends with }) but invalid JSON → malformed.
      await appendFile(join(d, "events.jsonl"), '{"id":"broken","ts":}\n', "utf-8");
      // Cut off mid-write (no closing brace) → truncated.
      await appendFile(join(d, "events.jsonl"), '{"id":"trunc","skillName":"revi\n', "utf-8");

      const r = await checkStoreIntegrity(d);
      assert.equal(r.totalLines, 3);
      assert.equal(r.validEvents, 1);
      assert.equal(r.malformedLines, 1);
      assert.equal(r.truncatedLines, 1);
    });

    it("returns an empty report for a store that does not exist", async () => {
      const r = await checkStoreIntegrity(dir + "-integrity-missing");
      assert.equal(r.totalLines, 0);
      assert.equal(r.validEvents, 0);
      assert.equal(r.tmpLeftover, null);
    });

    it("detects a stray events.jsonl.tmp leftover", async () => {
      const d = dir + "-integrity-tmp";
      await appendEvent(makeEvent({ id: "v1" }), d);
      const tmpPath = join(d, "events.jsonl.tmp");
      await appendFile(tmpPath, "partial", "utf-8");

      const r = await checkStoreIntegrity(d);
      assert.equal(r.tmpLeftover, tmpPath);
    });
  });

  describe("fixStore (#175)", () => {
    it("removes bad lines, keeps valid events, and backs up the original", async () => {
      const d = dir + "-fix-basic";
      await appendEvent(makeEvent({ id: "keep-1" }), d);
      await appendFile(join(d, "events.jsonl"), "NOT_VALID_JSON\n", "utf-8");
      await appendEvent(makeEvent({ id: "keep-2" }), d);

      const before = await readFile(join(d, "events.jsonl"), "utf-8");
      const res = await fixStore(d);

      assert.equal(res.removed, 1);
      assert.equal(res.kept, 2);
      assert.equal(res.backupPath, join(d, "events.jsonl.bak"));
      assert.equal(res.removedTmp, null);

      // The backup preserves the pre-repair content verbatim.
      const backup = await readFile(join(d, "events.jsonl.bak"), "utf-8");
      assert.equal(backup, before);

      // The repaired store parses cleanly and retains both valid events.
      const events = await readEvents(d);
      assert.deepEqual(events.map((e) => e.id).sort(), ["keep-1", "keep-2"]);

      const after = await checkStoreIntegrity(d);
      assert.equal(after.malformedLines + after.truncatedLines, 0);
    });

    it("removes a stray temp file even when the store is already clean", async () => {
      const d = dir + "-fix-tmp";
      await appendEvent(makeEvent({ id: "v1" }), d);
      const tmpPath = join(d, "events.jsonl.tmp");
      await appendFile(tmpPath, "partial", "utf-8");

      const res = await fixStore(d);
      assert.equal(res.removed, 0);
      assert.equal(res.kept, 1);
      assert.equal(res.removedTmp, tmpPath);

      const after = await checkStoreIntegrity(d);
      assert.equal(after.tmpLeftover, null);
    });

    it("is a no-op backup-wise when there is no store file", async () => {
      const res = await fixStore(dir + "-fix-missing");
      assert.equal(res.backupPath, null);
      assert.equal(res.removed, 0);
      assert.equal(res.kept, 0);
    });
  });
});
