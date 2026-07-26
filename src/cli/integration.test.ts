// End-to-end CLI tests: spawn the real CLI entry point as a subprocess against
// a fully sandboxed HOME / event store / fake session-log directory, so we
// exercise the actual command wiring (commander options, file I/O, hook
// payload handling) rather than individual functions in isolation (#17, #58, #61).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
