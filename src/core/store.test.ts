import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  appendEvent, readEvents, clearEvents, pruneEvents, backupEvents, pendingWriteQueueCount, selectNewEvents, DEDUP_WINDOW_MS,
  checkStore, repairStore, updateEvent, mergeStores, readLastEvent, enrichExistingEvents,
  mergeEventSources, readEventSource,
} from "./store.js";
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

    it("filters by sessionId at read time (#194)", async () => {
      const sessionDir = dir + "-session";
      await appendEvent(makeEvent({ id: "a", sessionId: "session-1" }), sessionDir);
      await appendEvent(makeEvent({ id: "b", sessionId: "session-2" }), sessionDir);
      await appendEvent(makeEvent({ id: "c", sessionId: "session-1" }), sessionDir);
      const scoped = await readEvents({ dir: sessionDir, sessionId: "session-1" });
      assert.deepEqual(scoped.map(e => e.id), ["a", "c"]);
      const other = await readEvents({ dir: sessionDir, sessionId: "session-2" });
      assert.deepEqual(other.map(e => e.id), ["b"]);
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

  describe("selectNewEvents (#182)", () => {
    // A hook-captured event (random UUID) and the scan-captured event for the
    // same invocation (tool_use id) must be recognised as one, so scan doesn't
    // store a second copy of every hook event.
    const hookEvent = makeEvent({
      id: "uuid-random-1234",
      timestamp: "2026-01-01T00:00:01.000Z",
      sessionId: "s1",
      skillName: "commit",
      source: "user",
    });
    const scanOfSameInvocation = makeEvent({
      id: "toolu_abc123",
      // scan reads the assistant message timestamp — close to but not equal to
      // the hook's fire time.
      timestamp: "2026-01-01T00:00:02.500Z",
      sessionId: "s1",
      skillName: "commit",
      source: "claude",
    });

    it("drops a scanned event that matches a stored hook event by session/skill/args + time window", () => {
      const fresh = selectNewEvents([hookEvent], [scanOfSameInvocation]);
      assert.deepEqual(fresh, []);
    });

    it("keeps a scanned event whose timestamp is outside the dedup window", () => {
      const later = makeEvent({
        ...scanOfSameInvocation,
        id: "toolu_later",
        timestamp: new Date(Date.parse(hookEvent.timestamp) + DEDUP_WINDOW_MS + 1000).toISOString(),
      });
      const fresh = selectNewEvents([hookEvent], [later]);
      assert.deepEqual(fresh.map((e) => e.id), ["toolu_later"]);
    });

    it("does not merge events with different skill args", () => {
      const other = makeEvent({
        ...scanOfSameInvocation,
        id: "toolu_diff_args",
        skillArgs: "--force",
      });
      const fresh = selectNewEvents([makeEvent({ ...hookEvent, skillArgs: "--dry-run" })], [other]);
      assert.deepEqual(fresh.map((e) => e.id), ["toolu_diff_args"]);
    });

    it("does not merge events from different sessions", () => {
      const other = makeEvent({ ...scanOfSameInvocation, id: "toolu_other_session", sessionId: "s2" });
      const fresh = selectNewEvents([hookEvent], [other]);
      assert.deepEqual(fresh.map((e) => e.id), ["toolu_other_session"]);
    });

    it("is idempotent across repeated scans (exact id already stored)", () => {
      const fresh = selectNewEvents([scanOfSameInvocation], [scanOfSameInvocation]);
      assert.deepEqual(fresh, []);
    });

    it("preserves two distinct invocations of the same skill in one scan batch", () => {
      const first = makeEvent({ id: "toolu_1", timestamp: "2026-01-01T00:00:00.000Z", sessionId: "s1", skillName: "commit" });
      const second = makeEvent({ id: "toolu_2", timestamp: "2026-01-01T00:00:01.000Z", sessionId: "s1", skillName: "commit" });
      // Candidates are only compared against `existing`, never each other, so both survive.
      const fresh = selectNewEvents([], [first, second]);
      assert.deepEqual(fresh.map((e) => e.id).sort(), ["toolu_1", "toolu_2"]);
    });
  });

  describe("enrichExistingEvents (#223)", () => {
    // A candidate dropped by selectNewEvents (matches an existing event by id
    // or sameInvocation) isn't necessarily redundant — scan can carry a
    // triggerMessage/source the hook-captured event was never able to record.
    const hookEvent = makeEvent({
      id: "uuid-random-1234",
      timestamp: "2026-01-01T00:00:01.000Z",
      sessionId: "s1",
      skillName: "commit",
      source: "claude",
    });
    const scanOfSameInvocation = makeEvent({
      id: "toolu_abc123",
      timestamp: "2026-01-01T00:00:02.500Z",
      sessionId: "s1",
      skillName: "commit",
      source: "user",
      triggerMessage: "please commit this",
    });

    it("backfills triggerMessage onto the existing event when it has none", () => {
      const enrichments = enrichExistingEvents(
        [{ ...hookEvent, source: "user" }],
        [{ ...scanOfSameInvocation, source: "user" }]
      );
      assert.deepEqual(enrichments, [
        { id: "uuid-random-1234", patch: { triggerMessage: "please commit this" } },
      ]);
    });

    it("upgrades source from \"claude\" to \"user\" when scan found stronger evidence", () => {
      const enrichments = enrichExistingEvents(
        [{ ...hookEvent, triggerMessage: "already have one" }],
        [{ ...scanOfSameInvocation, triggerMessage: "already have one" }]
      );
      assert.deepEqual(enrichments, [{ id: "uuid-random-1234", patch: { source: "user" } }]);
    });

    it("backfills both triggerMessage and source in one patch when both are missing", () => {
      const enrichments = enrichExistingEvents([hookEvent], [scanOfSameInvocation]);
      assert.deepEqual(enrichments, [
        {
          id: "uuid-random-1234",
          patch: { triggerMessage: "please commit this", source: "user" },
        },
      ]);
    });

    it("never downgrades source from \"user\" to \"claude\"", () => {
      const existingUser = { ...hookEvent, source: "user" as const, triggerMessage: "keep me" };
      const candidateClaude = { ...scanOfSameInvocation, source: "claude" as const };
      const enrichments = enrichExistingEvents([existingUser], [candidateClaude]);
      assert.deepEqual(enrichments, []);
    });

    it("never overwrites an existing triggerMessage with the candidate's", () => {
      const existingWithMessage = { ...hookEvent, triggerMessage: "original message" };
      const enrichments = enrichExistingEvents([existingWithMessage], [scanOfSameInvocation]);
      // source is still upgraded, but triggerMessage is left untouched.
      assert.deepEqual(enrichments, [{ id: "uuid-random-1234", patch: { source: "user" } }]);
    });

    it("produces no enrichment when nothing new is available", () => {
      const alreadyRich = { ...hookEvent, source: "user" as const, triggerMessage: "already have one" };
      const enrichments = enrichExistingEvents([alreadyRich], [scanOfSameInvocation]);
      assert.deepEqual(enrichments, []);
    });

    it("produces no enrichment when the candidate does not match any existing event", () => {
      const otherSession = { ...scanOfSameInvocation, sessionId: "s2" };
      const enrichments = enrichExistingEvents([hookEvent], [otherSession]);
      assert.deepEqual(enrichments, []);
    });

    it("leaves every field other than triggerMessage/source untouched", () => {
      const enrichments = enrichExistingEvents([hookEvent], [scanOfSameInvocation]);
      assert.deepEqual(Object.keys(enrichments[0]!.patch).sort(), ["source", "triggerMessage"]);
    });

    it("enriches the existing hook-captured event in the store via updateEvent, without creating a duplicate (#223)", async () => {
      const enrichDir = dir + "-enrich";
      await appendEvent(hookEvent, enrichDir);
      const stored = await readEvents(enrichDir);
      const enrichments = enrichExistingEvents(stored, [scanOfSameInvocation]);
      assert.equal(enrichments.length, 1);
      for (const e of enrichments) await updateEvent(e.id, e.patch, enrichDir);

      const after = await readEvents(enrichDir);
      assert.equal(after.length, 1, "the scan candidate must not be appended as a second row");
      assert.equal(after[0]!.id, hookEvent.id, "the original hook-captured id is preserved");
      assert.equal(after[0]!.recordedVia, hookEvent.recordedVia);
      assert.equal(after[0]!.triggerMessage, "please commit this");
      assert.equal(after[0]!.source, "user");
    });
  });

  describe("appendEvent schema stamping (#94)", () => {
    it("stamps the current schema version on write", async () => {
      const vDir = dir + "-schema";
      await appendEvent(makeEvent({ id: "v-test" }), vDir);
      const [ev] = await readEvents(vDir);
      assert.equal(ev!.v, 3);
    });
  });

  describe("readLastEvent (#70)", () => {
    it("returns undefined for a missing store", async () => {
      assert.equal(await readLastEvent(dir + "-missing-last"), undefined);
    });

    it("returns the most recently appended event", async () => {
      const lastDir = dir + "-last";
      await appendEvent(makeEvent({ id: "first" }), lastDir);
      await appendEvent(makeEvent({ id: "second" }), lastDir);
      const last = await readLastEvent(lastDir);
      assert.equal(last?.id, "second");
    });
  });

  describe("updateEvent (#127, #144)", () => {
    it("applies a partial patch to the matching event", async () => {
      const upDir = dir + "-update";
      await appendEvent(makeEvent({ id: "target" }), upDir);
      const found = await updateEvent("target", { outcome: "ok", durationMs: 42 }, upDir);
      assert.equal(found, true);
      const [ev] = await readEvents(upDir);
      assert.equal(ev!.outcome, "ok");
      assert.equal(ev!.durationMs, 42);
    });

    it("applies a function patch", async () => {
      const upDir = dir + "-update-fn";
      await appendEvent(makeEvent({ id: "target" }), upDir);
      await updateEvent("target", (ev) => ({ ...ev, tags: [...(ev.tags ?? []), "reviewed"] }), upDir);
      const [ev] = await readEvents(upDir);
      assert.deepEqual(ev!.tags, ["reviewed"]);
    });

    it("returns false when the event ID does not exist", async () => {
      const upDir = dir + "-update-missing";
      await appendEvent(makeEvent({ id: "x" }), upDir);
      const found = await updateEvent("does-not-exist", { outcome: "ok" }, upDir);
      assert.equal(found, false);
    });
  });

  describe("mergeStores (#132)", () => {
    it("merges events from multiple directories, deduping by ID, sorted by timestamp", async () => {
      const dirA = dir + "-merge-a";
      const dirB = dir + "-merge-b";
      await appendEvent(makeEvent({ id: "shared", timestamp: "2026-01-01T00:00:00.000Z" }), dirA);
      await appendEvent(makeEvent({ id: "shared", timestamp: "2026-01-01T00:00:00.000Z" }), dirB);
      await appendEvent(makeEvent({ id: "only-in-b", timestamp: "2026-01-02T00:00:00.000Z" }), dirB);
      const merged = await mergeStores([dirA, dirB]);
      assert.deepEqual(merged.map((e) => e.id), ["shared", "only-in-b"]);
    });
  });

  describe("mergeEventSources / readEventSource (#226)", () => {
    it("reads a raw JSONL file (one event per line)", async () => {
      const file = dir + "-merge226-a.jsonl";
      await writeFile(
        file,
        `${JSON.stringify(makeEvent({ id: "a" }))}\n${JSON.stringify(makeEvent({ id: "b" }))}\n`,
        "utf-8"
      );
      const events = await readEventSource(file);
      assert.deepEqual(events.map((e) => e.id), ["a", "b"]);
    });

    it("reads a JSON array file, e.g. `export --format json` output", async () => {
      const file = dir + "-merge226-b.json";
      await writeFile(
        file,
        JSON.stringify([makeEvent({ id: "x" }), makeEvent({ id: "y" })], null, 2),
        "utf-8"
      );
      const events = await readEventSource(file);
      assert.deepEqual(events.map((e) => e.id), ["x", "y"]);
    });

    it("reads a store directory the same way mergeStores does", async () => {
      const storeDir = dir + "-merge226-storedir";
      await appendEvent(makeEvent({ id: "from-dir" }), storeDir);
      const events = await readEventSource(storeDir);
      assert.deepEqual(events.map((e) => e.id), ["from-dir"]);
    });

    it("skips malformed lines/entries in a JSONL file without losing valid ones", async () => {
      const file = dir + "-merge226-corrupt.jsonl";
      await writeFile(
        file,
        `${JSON.stringify(makeEvent({ id: "ok" }))}\nNOT VALID JSON\n${JSON.stringify({ notAnEvent: true })}\n`,
        "utf-8"
      );
      const events = await readEventSource(file);
      assert.deepEqual(events.map((e) => e.id), ["ok"]);
    });

    it("throws a clear error for a source that does not exist", async () => {
      await assert.rejects(
        () => readEventSource(dir + "-merge226-does-not-exist.jsonl"),
        /Source not found or not readable/
      );
    });

    it("merges a JSON export file, a JSONL file and a store directory, deduping by ID and sorting by timestamp", async () => {
      const jsonFile = dir + "-merge226-c.json";
      const jsonlFile = dir + "-merge226-c.jsonl";
      const storeDir = dir + "-merge226-c-storedir";
      await writeFile(
        jsonFile,
        JSON.stringify([
          makeEvent({ id: "shared", timestamp: "2026-01-01T00:00:00.000Z" }),
          makeEvent({ id: "from-json", timestamp: "2026-01-03T00:00:00.000Z" }),
        ]),
        "utf-8"
      );
      await writeFile(
        jsonlFile,
        `${JSON.stringify(makeEvent({ id: "shared", timestamp: "2026-01-01T00:00:00.000Z" }))}\n${JSON.stringify(makeEvent({ id: "from-jsonl", timestamp: "2026-01-02T00:00:00.000Z" }))}\n`,
        "utf-8"
      );
      await appendEvent(
        makeEvent({ id: "from-dir", timestamp: "2026-01-04T00:00:00.000Z" }),
        storeDir
      );

      const { events, duplicates } = await mergeEventSources([jsonFile, jsonlFile, storeDir]);
      assert.deepEqual(events.map((e) => e.id), [
        "shared",
        "from-jsonl",
        "from-json",
        "from-dir",
      ]);
      assert.equal(duplicates, 1);
    });

    it("propagates a clear error when one of several sources is missing", async () => {
      const okFile = dir + "-merge226-d.jsonl";
      await writeFile(okFile, `${JSON.stringify(makeEvent({ id: "ok" }))}\n`, "utf-8");
      await assert.rejects(
        () => mergeEventSources([okFile, dir + "-merge226-d-missing.jsonl"]),
        /Source not found or not readable/
      );
    });
  });

  describe("checkStore / repairStore (#175)", () => {
    it("reports a clean store as having zero corrupt lines and no duplicates", async () => {
      const checkDir = dir + "-check-clean";
      await appendEvent(makeEvent({ id: "a" }), checkDir);
      await appendEvent(makeEvent({ id: "b" }), checkDir);
      const result = await checkStore(checkDir);
      assert.equal(result.validEvents, 2);
      assert.deepEqual(result.corruptLines, []);
      assert.deepEqual(result.duplicateIds, []);
    });

    it("detects corrupt lines and duplicate IDs without modifying the file", async () => {
      const checkDir = dir + "-check-corrupt";
      await appendEvent(makeEvent({ id: "a" }), checkDir);
      const path = join(checkDir, "events.jsonl");
      await appendFile(path, "NOT VALID JSON\n", "utf-8");
      await appendFile(path, `${JSON.stringify(makeEvent({ id: "a" }))}\n`, "utf-8");

      const before = await readFile(path, "utf-8");
      const result = await checkStore(checkDir);
      assert.equal(result.corruptLines.length, 1);
      assert.deepEqual(result.duplicateIds, ["a"]);
      assert.equal(await readFile(path, "utf-8"), before, "checkStore must not modify the file");
    });

    it("repairStore drops corrupt/duplicate lines and backs up the original", async () => {
      const repairDir = dir + "-repair";
      await appendEvent(makeEvent({ id: "a" }), repairDir);
      const path = join(repairDir, "events.jsonl");
      await appendFile(path, "NOT VALID JSON\n", "utf-8");
      await appendFile(path, `${JSON.stringify(makeEvent({ id: "a" }))}\n`, "utf-8");

      const result = await repairStore(repairDir);
      assert.equal(result.kept, 1);
      assert.equal(result.droppedCorrupt, 1);
      assert.equal(result.droppedDuplicates, 1);

      const events = await readEvents(repairDir);
      assert.deepEqual(events.map((e) => e.id), ["a"]);
      const backup = await readFile(`${path}.bak`, "utf-8");
      assert.ok(backup.includes("NOT VALID JSON"));
    });

    it("repairStore on a missing store is a no-op", async () => {
      const result = await repairStore(dir + "-repair-missing");
      assert.deepEqual(result, { kept: 0, droppedCorrupt: 0, droppedDuplicates: 0 });
    });
  });
});
