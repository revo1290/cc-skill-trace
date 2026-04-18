import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvent, readEvents, clearEvents } from "./store.js";
function makeEvent(overrides = {}) {
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
    let dir;
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
});
//# sourceMappingURL=store.test.js.map