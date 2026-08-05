// End-to-end CLI tests: spawn the real CLI entry point as a subprocess against
// a fully sandboxed HOME / event store / fake session-log directory, so we
// exercise the actual command wiring (commander options, file I/O, hook
// payload handling) rather than individual functions in isolation (#17, #58, #61).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));

function jsonl(entries: object[]): string {
  return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

describe("CLI integration", () => {
  let home: string;
  let store: string;
  let projects: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-skill-trace-cli-test-"));
    home = join(root, "home");
    store = join(root, "store");
    projects = join(root, "projects", "fake-project");
    await mkdir(home, { recursive: true });
    await mkdir(store, { recursive: true });
    await mkdir(projects, { recursive: true });
    env = {
      ...process.env,
      // node:os homedir() reads $HOME on POSIX but %USERPROFILE% on Windows —
      // set both so the sandbox actually redirects ~/.claude on every platform.
      HOME: home,
      USERPROFILE: home,
      CC_STORE_DIR: store,
      CC_PROJECTS_DIR: join(root, "projects"),
      NO_COLOR: "1",
    };
  });

  after(async () => {
    await rm(join(home, ".."), { recursive: true, force: true });
  });

  function run(args: string[], input?: string): string {
    return execFileSync("node", ["--import", "tsx/esm", CLI_ENTRY, ...args], {
      env, encoding: "utf-8", input: input ?? "", timeout: 15_000,
    });
  }

  it("show prints the empty-state hint when no events exist", () => {
    const out = run(["show"]);
    assert.ok(out.includes("No events yet"));
  });

  it("install registers hooks and the skill under the sandboxed HOME", () => {
    const out = run(["install"]);
    assert.ok(out.includes("PreToolUse hook installed"));
    assert.ok(out.includes("PostToolUse hook installed"));
    assert.ok(out.includes("Skill installed"));
  });

  it("install --check exits 0 once hooks and skill are present", () => {
    // Throws (non-zero exit) if this fails — reaching here is the assertion.
    run(["install", "--check"]);
  });

  it("re-running install does not duplicate the hook entry (#136)", async () => {
    const out = run(["install"]);
    assert.ok(out.includes("PreToolUse hook already registered"));
    const settingsPath = join(home, ".claude", "settings.json");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const preCount = settings.hooks.PreToolUse.filter((h) =>
      JSON.stringify(h).includes("cc-skill-trace"),
    ).length;
    assert.equal(preCount, 1, "PreToolUse must contain exactly one cc-skill-trace entry");
  });

  it("hook-capture appends a PreToolUse event and dedups an immediate repeat (#70)", () => {
    const payload = JSON.stringify({
      session_id: "live-sess", tool_name: "Skill",
      tool_input: { skill: "pdf" }, user_invoked: false,
      cwd: "/repo", git_branch: "main",
    });
    const out1 = run(["hook-capture"], payload);
    assert.equal(out1, "{}");
    run(["hook-capture"], payload); // immediate duplicate — must be suppressed

    const json = JSON.parse(run(["show", "--json", "--session", "live-sess"]));
    assert.equal(json.length, 1);
    assert.equal(json[0].skillName, "pdf");
    assert.equal(json[0].recordedVia, "hook");
  });

  it("hook-capture --post marks the outcome on the matching event (#144)", () => {
    const post = JSON.stringify({
      session_id: "live-sess", tool_name: "Skill",
      tool_input: { skill: "pdf" }, tool_response: { is_error: false },
    });
    run(["hook-capture", "--post"], post);
    const [ev] = JSON.parse(run(["show", "--json", "--session", "live-sess"]));
    assert.equal(ev.outcome, "ok");
    assert.ok(typeof ev.durationMs === "number");
  });

  it("hook-capture never throws on malformed stdin", () => {
    const out = run(["hook-capture"], "NOT JSON AT ALL");
    assert.equal(out, "{}");
  });

  it("scan backfills events from a fabricated session log", async () => {
    await writeFile(join(projects, "sess1.jsonl"), jsonl([
      { type: "message", timestamp: "2026-01-05T09:00:00.000Z", sessionId: "sess1", message: { role: "user", content: "help me commit" } },
      { type: "message", timestamp: "2026-01-05T09:00:01.000Z", sessionId: "sess1", message: { role: "assistant", content: [{ type: "tool_use", id: "tu-1", name: "Skill", input: { skill: "commit" } }] } },
    ]));
    const out = run(["scan"]);
    assert.ok(out.includes("Imported 1 new invocations"));
  });

  it("scan is idempotent — re-scanning imports zero new events", () => {
    const out = run(["scan"]);
    assert.ok(out.includes("Imported 0 new invocations"));
    assert.ok(out.includes("enriched 0 existing"));
  });

  it("scan enriches an existing hook-captured event with triggerMessage and an upgraded source instead of duplicating it (#223)", async () => {
    // 1. Real-time hook capture: no triggerMessage available (never delivered
    //    with PreToolUse), and source defaults to "claude" since nothing in
    //    the payload indicates an explicit invocation.
    const out1 = run(["hook-capture"], JSON.stringify({
      session_id: "enrich-sess", tool_name: "Skill",
      tool_input: { skill: "release" }, user_invoked: false,
    }));
    assert.equal(out1, "{}");
    // Captured right after the hook-capture process returns so it lands well
    // inside the (5s) hook/scan dedup window around the hook's own timestamp.
    const preTs = new Date().toISOString();

    // 2. scan reads the full session log for the SAME invocation: it has the
    //    preceding user message (triggerMessage) and an explicit user_invoked
    //    flag (stronger source evidence). The assistant message timestamp is
    //    close to "now" so it falls inside the hook/scan dedup window and is
    //    recognised as the same invocation rather than a new one.
    await writeFile(join(projects, "enrich-sess.jsonl"), jsonl([
      { type: "message", timestamp: preTs, sessionId: "enrich-sess", message: { role: "user", content: "/release please" } },
      { type: "message", timestamp: preTs, sessionId: "enrich-sess", message: { role: "assistant", content: [{ type: "tool_use", id: "tu-enrich", name: "Skill", input: { skill: "release" }, user_invoked: true }] } },
    ]));

    const out2 = run(["scan"]);
    assert.ok(out2.includes("Imported 0 new invocations"), "the matched candidate must not be stored as a second row");
    assert.ok(out2.includes("enriched 1 existing"));

    const events = JSON.parse(run(["show", "--json", "--session", "enrich-sess"]));
    assert.equal(events.length, 1, "still exactly one event for this invocation, not a duplicate");
    const [ev] = events;
    assert.equal(ev.recordedVia, "hook", "the original hook-captured row is kept, patched in place");
    assert.equal(ev.triggerMessage, "/release please");
    assert.equal(ev.source, "user");
  });

  it("stats renders daily activity for the combined event set", () => {
    const out = run(["stats"]);
    assert.ok(out.includes("Daily activity"));
  });

  it("list-skills lists every distinct skill name seen so far", () => {
    const out = run(["list-skills"]);
    assert.ok(out.includes("pdf"));
    assert.ok(out.includes("commit"));
  });

  it("export --format json round-trips valid JSON", () => {
    const out = run(["export", "--format", "json"]);
    const events = JSON.parse(out);
    assert.ok(Array.isArray(events));
    assert.ok(events.length >= 2);
  });

  it("export --format csv includes a UTF-8 BOM by default", () => {
    const out = run(["export", "--format", "csv"]);
    assert.equal(out.charCodeAt(0), 0xfeff);
  });

  it("check --max-auto-rate exits non-zero when the threshold is exceeded", () => {
    assert.throws(() => run(["check", "--max-auto-rate", "0"]));
  });

  it("check --max-auto-rate exits zero when within threshold", () => {
    run(["check", "--max-auto-rate", "100"]); // throws on failure
  });

  it("tag adds a label to an event by ID, retrievable via --tag filter", () => {
    const [ev] = JSON.parse(run(["show", "--json", "--skill", "commit"]));
    run(["tag", ev.id, "--add", "reviewed"]);
    const tagged = JSON.parse(run(["show", "--json", "--tag", "reviewed"]));
    assert.equal(tagged.length, 1);
    assert.equal(tagged[0].id, ev.id);
  });

  it("doctor reports a healthy store", () => {
    const out = run(["doctor"]);
    assert.ok(out.includes("event store healthy") || out.includes("All checks passed"));
  });

  it("uninstall removes only cc-skill-trace hooks and preserves a third-party hook (#129)", async () => {
    const settingsPath = join(home, ".claude", "settings.json");
    const current = JSON.parse(await readFile(settingsPath, "utf-8"));
    current.hooks.PreToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: "some-other-tool --check" }],
    });
    await writeFile(settingsPath, JSON.stringify(current, null, 2), "utf-8");

    run(["uninstall", "--force"]);

    const after = JSON.parse(await readFile(settingsPath, "utf-8"));
    const commands = JSON.stringify(after.hooks.PreToolUse);
    assert.ok(!commands.includes("cc-skill-trace"));
    assert.ok(commands.includes("some-other-tool --check"));
  });
});

describe("hook-capture cross-process concurrency (#161)", () => {
  // appendEvent uses fs.appendFile (O_APPEND), which POSIX guarantees is
  // atomic for writes below PIPE_BUF — this stress test spawns many real
  // `hook-capture` *processes* concurrently (not just concurrent promises in
  // one process) to verify that guarantee holds in practice: every event
  // survives and events.jsonl parses cleanly with no torn/interleaved lines.
  it("N concurrent hook-capture processes each append exactly one clean event", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-skill-trace-concurrency-test-"));
    const store = join(root, "store");
    await mkdir(store, { recursive: true });
    const env = { ...process.env, CC_STORE_DIR: store, NO_COLOR: "1" };

    const N = 15;
    const runOne = (i: number) =>
      new Promise<void>((resolvePromise, reject) => {
        const child = spawn("node", ["--import", "tsx/esm", CLI_ENTRY, "hook-capture"], { env });
        const payload = JSON.stringify({
          session_id: `concurrent-sess-${i}`,
          tool_name: "Skill",
          tool_input: { skill: `skill-${i}` },
          user_invoked: false,
        });
        child.stdin.end(payload);
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`exit ${code}`))));
      });

    await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));

    const raw = await readFile(join(store, "events.jsonl"), "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    assert.equal(lines.length, N, "every process's event must be present with no torn/lost lines");
    const parsed = lines.map((l) => JSON.parse(l)); // throws if any line is corrupted/interleaved
    const sessions = new Set(parsed.map((e) => e.sessionId));
    assert.equal(sessions.size, N, "each event must be distinct — no duplicates or overwrites");

    await rm(root, { recursive: true, force: true });
  });
});

describe("multi-provider install/hook-capture (#v3-multi-provider)", () => {
  let home: string;
  let store: string;
  let env: NodeJS.ProcessEnv;

  before(async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-skill-trace-provider-cli-test-"));
    home = join(root, "home");
    store = join(root, "store");
    await mkdir(home, { recursive: true });
    await mkdir(store, { recursive: true });
    env = { ...process.env, HOME: home, USERPROFILE: home, CC_STORE_DIR: store, NO_COLOR: "1" };
  });

  after(async () => {
    await rm(join(home, ".."), { recursive: true, force: true });
  });

  function run(args: string[], input?: string): string {
    return execFileSync("node", ["--import", "tsx/esm", CLI_ENTRY, ...args], {
      env, encoding: "utf-8", input: input ?? "", timeout: 15_000,
    });
  }

  it("install --provider codex writes a wildcard-matcher hook to ~/.codex/hooks.json", async () => {
    const out = run(["install", "--provider", "codex"]);
    assert.ok(out.includes("best-effort"));
    assert.ok(out.includes("PreToolUse hook installed"));
    const hooksPath = join(home, ".codex", "hooks.json");
    const settings = JSON.parse(await readFile(hooksPath, "utf-8"));
    assert.equal(settings.hooks.PreToolUse[0].matcher, "*");
    assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes("--provider codex"));
    // The claude-code settings file must be untouched by a codex install.
    await assert.rejects(readFile(join(home, ".claude", "settings.json"), "utf-8"));
  });

  it("hook-capture --provider codex detects a skill invocation via a SKILL.md path match", async () => {
    const skillDir = join(home, ".codex", "skills", "github");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(skillPath, "---\nname: github\ndescription: Work with GitHub\n---\n");

    const payload = JSON.stringify({
      session_id: "codex-sess-1",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: `sed -n '1,220p' ${skillPath}` },
    });
    const out = run(["hook-capture", "--provider", "codex"], payload);
    assert.equal(out, "{}");

    const raw = await readFile(join(store, "events.jsonl"), "utf-8");
    const events = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const ev = events.find((e) => e.sessionId === "codex-sess-1");
    assert.ok(ev, "expected an event for codex-sess-1");
    assert.equal(ev.skillName, "github");
    assert.equal(ev.provider, "codex");
    assert.equal(ev.recordedVia, "hook");
    assert.equal(ev.source, "claude");
  });

  it("hook-capture --provider copilot parses the camelCase payload shape", async () => {
    const skillDir = join(home, ".copilot", "skills", "pdf");
    await mkdir(skillDir, { recursive: true });
    const skillPath = join(skillDir, "SKILL.md");
    await writeFile(skillPath, "---\nname: pdf\ndescription: Extract PDF text\n---\n");

    const payload = JSON.stringify({
      sessionId: "copilot-sess-1",
      cwd: "/repo",
      toolName: "shell",
      toolArgs: { command: `cat ${skillPath}` },
    });
    const out = run(["hook-capture", "--provider", "copilot"], payload);
    assert.equal(out, "{}");

    const raw = await readFile(join(store, "events.jsonl"), "utf-8");
    const events = raw
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const ev = events.find((e) => e.sessionId === "copilot-sess-1");
    assert.ok(ev, "expected an event for copilot-sess-1");
    assert.equal(ev.skillName, "pdf");
    assert.equal(ev.provider, "copilot");
  });

  it("hook-capture --provider codex is a no-op when the tool call references no known skill", async () => {
    const before = await readFile(join(store, "events.jsonl"), "utf-8");
    const payload = JSON.stringify({
      session_id: "codex-sess-unrelated",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
    });
    run(["hook-capture", "--provider", "codex"], payload);
    const after = await readFile(join(store, "events.jsonl"), "utf-8");
    assert.equal(before, after, "an unrelated tool call must not append an event");
  });

  it("uninstall --provider codex removes only the codex hook file's entry", async () => {
    const out = run(["uninstall", "--provider", "codex", "--force"]);
    assert.ok(out.includes("removed from"));
    const settings = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf-8"));
    assert.equal((settings.hooks.PreToolUse ?? []).length, 0);
  });
});
