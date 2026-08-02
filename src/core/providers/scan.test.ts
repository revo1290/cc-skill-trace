import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexProvider } from "./codex.js";
import { copilotProvider } from "./copilot.js";
import { extractAllInvocationsForProvider } from "./scan.js";

function jsonl(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("extractAllInvocationsForProvider", () => {
  let home: string;
  const prevHome = process.env["CC_CODEX_HOME"];

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "cc-skill-trace-provider-scan-test-"));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env["CC_CODEX_HOME"];
    else process.env["CC_CODEX_HOME"] = prevHome;
  });

  beforeEach(() => {
    process.env["CC_CODEX_HOME"] = home;
  });

  it("throws for a provider that does not support scanning (copilot)", async () => {
    await assert.rejects(() => extractAllInvocationsForProvider(copilotProvider), /does not support scanning/);
  });

  it("scans every session file for a scan-capable provider and sorts by timestamp", async () => {
    const skillDir = join(home, "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(skillPath, "---\nname: pdf\ndescription: PDF tools\n---\n");

    const day = join(home, "sessions", "2026", "01", "01");
    await mkdir(day, { recursive: true });

    await writeFile(
      join(day, "rollout-a.jsonl"),
      jsonl([
        { type: "session_meta", payload: { id: "sess-a" } },
        {
          type: "response_item",
          timestamp: "2026-01-01T09:00:00.000Z",
          payload: { type: "function_call", name: "exec_command", call_id: "c1", arguments: JSON.stringify({ cmd: `cat ${skillPath}` }) },
        },
      ])
    );
    await writeFile(
      join(day, "rollout-b.jsonl"),
      jsonl([
        { type: "session_meta", payload: { id: "sess-b" } },
        {
          type: "response_item",
          timestamp: "2026-01-01T08:00:00.000Z",
          payload: { type: "function_call", name: "exec_command", call_id: "c2", arguments: JSON.stringify({ cmd: `cat ${skillPath}` }) },
        },
      ])
    );

    const events = await extractAllInvocationsForProvider(codexProvider);
    assert.equal(events.length, 2);
    // sess-b's event (08:00) sorts before sess-a's (09:00)
    assert.deepEqual(events.map((e) => e.sessionId), ["sess-b", "sess-a"]);
    assert.ok(events.every((e) => e.provider === "codex"));
  });

  it("applies the `since` filter across all scanned files", async () => {
    const events = await extractAllInvocationsForProvider(codexProvider, { since: "2026-01-01T08:30:00.000Z" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.sessionId, "sess-a");
  });

  it("applies the `sessionId` filter", async () => {
    const events = await extractAllInvocationsForProvider(codexProvider, { sessionId: "sess-b" });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.sessionId, "sess-b");
  });
});
