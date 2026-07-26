import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractInvocationsFromFile, extractAllInvocations, isClaudeSessionFile, mapWithLimit, validateProjectsDir, listSessionFiles } from "./parser.js";
import { homedir } from "node:os";

function jsonl(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function userMsg(content: string, ts = "2026-01-01T00:00:00.000Z", sessionId = "sess-1") {
  return { type: "message", timestamp: ts, sessionId, message: { role: "user", content } };
}

function assistantSkill(skill: string, ts = "2026-01-01T00:00:01.000Z", sessionId = "sess-1") {
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
  let dir: string;

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

  it("prefers an explicit user_invoked flag over the trigger-message heuristic (#177)", async () => {
    // Trigger text starts with "/commit" so the regex heuristic alone would
    // mislabel this as user-invoked, but Claude Code recorded user_invoked=false.
    const file = join(dir, "explicit-claude.jsonl");
    await writeFile(file, jsonl([
      userMsg("/commit コマンドについて教えて"),
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        sessionId: "sess-1",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "tu-1", name: "Skill", input: { skill: "commit" }, user_invoked: false },
          ],
        },
      },
    ]));
    const events = await extractInvocationsFromFile(file);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "claude", "explicit user_invoked=false must win over the regex");
  });

  it("honors an entry-level user_invoked=true even when trigger text lacks a slash (#177)", async () => {
    const file = join(dir, "explicit-user.jsonl");
    await writeFile(file, jsonl([
      userMsg("please summarize this"),
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        sessionId: "sess-1",
        user_invoked: true,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Skill", input: { skill: "pdf" } }],
        },
      },
    ]));
    const events = await extractInvocationsFromFile(file);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "user", "explicit user_invoked=true must win over the regex");
  });

  it("falls back to the trigger-message heuristic when user_invoked is absent (#177)", async () => {
    const file = join(dir, "no-flag-heuristic.jsonl");
    await writeFile(file, jsonl([
      userMsg("/pdf rotate this"),
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

  it("skips non-Claude JSONL files that happen to live under the scan dir (#171)", async () => {
    const file = join(dir, "analytics.jsonl");
    // A user's own JSONL data set — valid JSON, but not a Claude session log.
    await writeFile(file, jsonl([
      { event: "pageview", url: "/home", ts: 123 },
      { event: "click", target: "button", ts: 124 },
    ]));
    const events = await extractInvocationsFromFile(file);
    assert.equal(events.length, 0);
  });

  it("isClaudeSessionFile detects session logs and rejects unrelated JSONL (#171)", async () => {
    const sessionFile = join(dir, "detect-session.jsonl");
    await writeFile(sessionFile, jsonl([userMsg("hi"), assistantSkill("pdf")]));
    assert.equal(await isClaudeSessionFile(sessionFile), true);

    const otherFile = join(dir, "detect-other.jsonl");
    await writeFile(otherFile, jsonl([{ event: "pageview", url: "/home" }]));
    assert.equal(await isClaudeSessionFile(otherFile), false);
  });

  it("populates injectedTokens from the following tool_result content (#34)", async () => {
    const file = join(dir, "injected-tokens.jsonl");
    const skillContent = "# My Skill\n" + "word ".repeat(80); // ~400 chars → ~100 tokens
    await writeFile(file, jsonl([
      userMsg("use my skill"),
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        sessionId: "sess-1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-tok", name: "Skill", input: { skill: "my-skill" } }],
        },
      },
      {
        type: "message",
        timestamp: "2026-01-01T00:00:02.000Z",
        sessionId: "sess-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-tok", content: skillContent }],
        },
      },
    ]));
    const events = await extractInvocationsFromFile(file);
    assert.equal(events.length, 1);
    assert.ok(events[0].injectedTokens != null, "injectedTokens should be populated");
    assert.ok((events[0].injectedTokens ?? 0) > 0, "injectedTokens should be positive");
  });

  it("respects triggerMaxLen option (#120)", async () => {
    const file = join(dir, "custom-max-len.jsonl");
    await writeFile(file, jsonl([userMsg("x".repeat(100)), assistantSkill("cap-test")]));
    const events = await extractInvocationsFromFile(file, { triggerMaxLen: 20 });
    assert.equal(events[0]!.triggerMessage!.length, 20);
  });

  it("omits triggerMessage when captureTriggerMessages is false (#74)", async () => {
    const file = join(dir, "no-capture.jsonl");
    await writeFile(file, jsonl([userMsg("sensitive request"), assistantSkill("privacy-test")]));
    const events = await extractInvocationsFromFile(file, { captureTriggerMessages: false });
    assert.equal(events[0]!.triggerMessage, undefined);
  });

  it("stamps recordedVia as 'scan' and carries cwd/gitBranch from the assistant entry", async () => {
    const file = join(dir, "cwd-branch.jsonl");
    await writeFile(file, jsonl([
      userMsg("help"),
      {
        type: "message",
        timestamp: "2026-01-01T00:00:01.000Z",
        sessionId: "sess-1",
        cwd: "/repo",
        gitBranch: "main",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-meta", name: "Skill", input: { skill: "meta-test" } }],
        },
      },
    ]));
    const events = await extractInvocationsFromFile(file);
    assert.equal(events[0]!.recordedVia, "scan");
    assert.equal(events[0]!.cwd, "/repo");
    assert.equal(events[0]!.gitBranch, "main");
  });
});

describe("mapWithLimit (#138)", () => {
  it("resolves results in input order regardless of completion order", async () => {
    const items = [30, 10, 20];
    const results = await mapWithLimit(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    assert.deepEqual(results, [30, 10, 20]);
  });

  it("never runs more than `limit` tasks concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapWithLimit(items, 3, async (i) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return i;
    });
    assert.ok(maxActive <= 3, `expected at most 3 concurrent, saw ${maxActive}`);
  });

  it("handles an empty input array", async () => {
    const results = await mapWithLimit([], 5, async (x) => x);
    assert.deepEqual(results, []);
  });

  it("handles limit greater than the number of items", async () => {
    const results = await mapWithLimit([1, 2], 10, async (x) => x * 2);
    assert.deepEqual(results, [2, 4]);
  });

  it("propagates a rejection from any task", async () => {
    await assert.rejects(
      mapWithLimit([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error("boom");
        return x;
      }),
      /boom/,
    );
  });
});

describe("extractAllInvocations sessionId filtering (#188)", () => {
  let projectsDir: string;
  const prev = process.env["CC_PROJECTS_DIR"];

  before(async () => {
    projectsDir = await mkdtemp(join(tmpdir(), "cc-skill-trace-scan-test-"));
    process.env["CC_PROJECTS_DIR"] = projectsDir;
    const proj = join(projectsDir, "some-project");
    await mkdir(proj, { recursive: true });
    // Two session files named after their session IDs (Claude Code convention).
    await writeFile(
      join(proj, "sess-A.jsonl"),
      jsonl([userMsg("help A", "2026-01-01T00:00:00.000Z", "sess-A"),
        assistantSkill("pdf", "2026-01-01T00:00:01.000Z", "sess-A")])
    );
    await writeFile(
      join(proj, "sess-B.jsonl"),
      jsonl([userMsg("help B", "2026-01-02T00:00:00.000Z", "sess-B"),
        assistantSkill("docx", "2026-01-02T00:00:01.000Z", "sess-B")])
    );
    // A file NOT named after its session ID — exercises the fallback path.
    await writeFile(
      join(proj, "renamed.jsonl"),
      jsonl([userMsg("help C", "2026-01-03T00:00:00.000Z", "sess-C"),
        assistantSkill("csv", "2026-01-03T00:00:01.000Z", "sess-C")])
    );
  });

  after(async () => {
    if (prev === undefined) delete process.env["CC_PROJECTS_DIR"];
    else process.env["CC_PROJECTS_DIR"] = prev;
    await rm(projectsDir, { recursive: true, force: true });
  });

  it("returns only events for the requested session (fast path by filename)", async () => {
    const events = await extractAllInvocations({ sessionId: "sess-A" });
    assert.equal(events.length, 1);
    assert.equal(events[0].sessionId, "sess-A");
    assert.equal(events[0].skillName, "pdf");
  });

  it("returns all sessions when no sessionId filter is given", async () => {
    const events = await extractAllInvocations();
    assert.deepEqual(events.map((e) => e.sessionId).sort(), ["sess-A", "sess-B", "sess-C"]);
  });

  it("falls back to a full scan when no file name matches the sessionId", async () => {
    const events = await extractAllInvocations({ sessionId: "sess-C" });
    assert.equal(events.length, 1);
    assert.equal(events[0].sessionId, "sess-C");
    assert.equal(events[0].skillName, "csv");
  });
});

describe("validateProjectsDir (#147)", () => {
  it("rejects /etc, /sys, /proc and /dev outright", () => {
    for (const dangerous of ["/etc", "/sys", "/proc", "/dev"]) {
      assert.throws(() => validateProjectsDir(dangerous), /not allowed for security reasons/);
    }
  });

  it("rejects subdirectories of disallowed roots", () => {
    assert.throws(() => validateProjectsDir("/etc/ssh"), /not allowed for security reasons/);
  });

  it("does not false-positive on a sibling path with the same prefix", () => {
    // "/etcetera" starts with "/etc" as a string but is not under /etc — must be allowed.
    assert.doesNotThrow(() => validateProjectsDir("/etcetera/projects"));
  });

  it("expands a leading ~ before validating", () => {
    assert.equal(validateProjectsDir("~/my-projects"), join(homedir(), "my-projects"));
  });

  it("allows ordinary user directories", () => {
    assert.doesNotThrow(() => validateProjectsDir("/home/user/.claude/projects"));
  });
});

describe("listSessionFiles missing-directory handling (#147)", () => {
  it("returns empty and warns on stderr when CC_PROJECTS_DIR does not exist", async () => {
    const prev = process.env["CC_PROJECTS_DIR"];
    const missing = join(tmpdir(), `cc-skill-trace-does-not-exist-${Date.now()}`);
    process.env["CC_PROJECTS_DIR"] = missing;
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const files = await listSessionFiles();
      assert.deepEqual(files, []);
      assert.ok(chunks.some((c) => c.includes(missing) && c.includes("does not exist")));
    } finally {
      process.stderr.write = originalWrite;
      if (prev === undefined) delete process.env["CC_PROJECTS_DIR"];
      else process.env["CC_PROJECTS_DIR"] = prev;
    }
  });
});
