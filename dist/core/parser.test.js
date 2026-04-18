import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInvocationsFromFile } from "./parser.js";
function jsonl(entries) {
    return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
function userMsg(content, ts = "2026-01-01T00:00:00.000Z", sessionId = "sess-1") {
    return { type: "message", timestamp: ts, sessionId, message: { role: "user", content } };
}
function assistantSkill(skill, ts = "2026-01-01T00:00:01.000Z", sessionId = "sess-1") {
    return {
        type: "message",
        timestamp: ts,
        sessionId,
        message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu-1", name: "Skill", input: { skill } }],
        },
    };
}
describe("extractInvocationsFromFile", () => {
    let dir;
    before(async () => {
        dir = await mkdtemp(join(tmpdir(), "cc-skill-trace-parser-test-"));
    });
    after(async () => {
        await rm(dir, { recursive: true, force: true });
    });
    it("returns empty array for file with no Skill tool calls", async () => {
        const file = join(dir, "no-skills.jsonl");
        await writeFile(file, jsonl([
            userMsg("hello"),
            { type: "message", timestamp: "2026-01-01T00:00:01.000Z", sessionId: "sess-1",
                message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
        ]));
        const events = await extractInvocationsFromFile(file);
        assert.equal(events.length, 0);
    });
    it("extracts a Skill call and marks it as claude-auto", async () => {
        const file = join(dir, "auto-trigger.jsonl");
        await writeFile(file, jsonl([
            userMsg("can you help with pdf?"),
            assistantSkill("pdf"),
        ]));
        const events = await extractInvocationsFromFile(file);
        assert.equal(events.length, 1);
        assert.equal(events[0].skillName, "pdf");
        assert.equal(events[0].source, "claude");
        assert.ok(events[0].triggerMessage?.includes("pdf"));
    });
    it("marks invocation as user-sourced when trigger starts with slash command", async () => {
        const file = join(dir, "user-invoked.jsonl");
        await writeFile(file, jsonl([
            userMsg("/pdf rotate this file"),
            assistantSkill("pdf"),
        ]));
        const events = await extractInvocationsFromFile(file);
        assert.equal(events.length, 1);
        assert.equal(events[0].source, "user");
    });
    it("extracts multiple Skill calls from one assistant message", async () => {
        const file = join(dir, "multi-skill.jsonl");
        await writeFile(file, jsonl([
            userMsg("do stuff"),
            {
                type: "message",
                timestamp: "2026-01-01T00:00:01.000Z",
                sessionId: "sess-1",
                message: {
                    role: "assistant",
                    content: [
                        { type: "tool_use", id: "tu-1", name: "Skill", input: { skill: "pdf" } },
                        { type: "tool_use", id: "tu-2", name: "Skill", input: { skill: "docx" } },
                    ],
                },
            },
        ]));
        const events = await extractInvocationsFromFile(file);
        assert.equal(events.length, 2);
        assert.deepEqual(events.map((e) => e.skillName).sort(), ["docx", "pdf"]);
    });
    it("handles malformed JSON lines without throwing", async () => {
        const file = join(dir, "malformed.jsonl");
        await writeFile(file, "NOT_JSON\n" + JSON.stringify(userMsg("hello")) + "\n");
        const events = await extractInvocationsFromFile(file);
        assert.equal(events.length, 0);
    });
    it("uses the tool_use block ID as event ID (deterministic across scans)", async () => {
        const file = join(dir, "stable-id.jsonl");
        await writeFile(file, jsonl([
            userMsg("help"),
            {
                type: "message",
                timestamp: "2026-01-01T00:00:01.000Z",
                sessionId: "sess-3",
                message: {
                    role: "assistant",
                    content: [{ type: "tool_use", id: "toolu_abc123", name: "Skill", input: { skill: "pdf" } }],
                },
            },
        ]));
        const run1 = await extractInvocationsFromFile(file);
        const run2 = await extractInvocationsFromFile(file);
        assert.equal(run1[0].id, "toolu_abc123");
        assert.equal(run1[0].id, run2[0].id, "ID must be stable across repeated scans");
    });
    it("truncates long trigger messages to 300 chars", async () => {
        const file = join(dir, "long-trigger.jsonl");
        const longMsg = "a".repeat(500);
        await writeFile(file, jsonl([userMsg(longMsg), assistantSkill("big-skill")]));
        const events = await extractInvocationsFromFile(file);
        assert.equal(events.length, 1);
        assert.ok((events[0].triggerMessage?.length ?? 0) <= 300);
    });
});
//# sourceMappingURL=parser.test.js.map