import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexProvider } from "./codex.js";

function jsonl(entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("codexProvider", () => {
  let home: string;
  const prevHome = process.env["CC_CODEX_HOME"];

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "cc-skill-trace-codex-test-"));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env["CC_CODEX_HOME"];
    else process.env["CC_CODEX_HOME"] = prevHome;
  });

  beforeEach(() => {
    process.env["CC_CODEX_HOME"] = home;
  });

  describe("listInstalledSkills", () => {
    it("finds skills under skills/ (nested, e.g. .system/<name>) and plugins/", async () => {
      const skillsDir = join(home, "skills", ".system", "skill-creator");
      await mkdir(skillsDir, { recursive: true });
      await writeFile(
        join(skillsDir, "SKILL.md"),
        "---\nname: skill-creator\ndescription: Create new skills\n---\n"
      );

      const pluginDir = join(home, "plugins", "cache", "openai-curated", "github", "abc123", "skills", "github");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "SKILL.md"), "---\nname: github\ndescription: Work with GitHub\n---\n");

      const skills = await codexProvider.listInstalledSkills();
      const names = skills.map((s) => s.name).sort();
      assert.deepEqual(names, ["github", "skill-creator"]);
      const github = skills.find((s) => s.name === "github");
      assert.equal(github?.path, join(pluginDir, "SKILL.md"));
    });

    it("returns an empty array when no skills directories exist", async () => {
      process.env["CC_CODEX_HOME"] = join(home, "does-not-exist");
      assert.deepEqual(await codexProvider.listInstalledSkills(), []);
    });
  });

  describe("listSessionFiles", () => {
    it("finds nested YYYY/MM/DD rollout files and filters by sessionId substring", async () => {
      const day = join(home, "sessions", "2026", "04", "19");
      await mkdir(day, { recursive: true });
      const uuid = "019da5e0-0b6a-7a22-8141-c91f5783d44a";
      await writeFile(join(day, `rollout-2026-04-19T22-13-36-${uuid}.jsonl`), "");
      await writeFile(join(day, "rollout-2026-04-19T23-00-00-other-uuid.jsonl"), "");

      const all = await codexProvider.listSessionFiles!();
      assert.equal(all.length, 2);

      const scoped = await codexProvider.listSessionFiles!(uuid);
      assert.equal(scoped.length, 1);
      assert.ok(scoped[0]!.path.includes(uuid));
    });
  });

  describe("extractInvocationsFromFile", () => {
    let skillPath: string;

    beforeEach(async () => {
      const skillDir = join(home, "skills", "github");
      await mkdir(skillDir, { recursive: true });
      skillPath = join(skillDir, "SKILL.md");
      await writeFile(skillPath, "---\nname: github\ndescription: Work with GitHub\n---\n");
    });

    it("detects a skill invocation via exec_command referencing the SKILL.md path (real observed shape)", async () => {
      const file = join(home, "sess.jsonl");
      await writeFile(
        file,
        jsonl([
          { type: "session_meta", payload: { id: "sess-abc", cwd: "/repo" } },
          {
            type: "response_item",
            timestamp: "2026-04-19T22:13:00.000Z",
            payload: { type: "message", role: "user", content: [{ type: "text", text: "help with github" }] },
          },
          {
            type: "response_item",
            timestamp: "2026-04-19T22:13:36.000Z",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call_1",
              arguments: JSON.stringify({ cmd: `sed -n '1,220p' ${skillPath}`, workdir: "/repo" }),
            },
          },
          {
            type: "response_item",
            timestamp: "2026-04-19T22:13:37.000Z",
            payload: { type: "function_call_output", call_id: "call_1", output: "# github skill content ".repeat(20) },
          },
        ])
      );

      const skills = await codexProvider.listInstalledSkills();
      const events = await codexProvider.extractInvocationsFromFile!(file, skills, {});
      assert.equal(events.length, 1);
      const ev = events[0]!;
      assert.equal(ev.skillName, "github");
      assert.equal(ev.sessionId, "sess-abc");
      assert.equal(ev.cwd, "/repo");
      assert.equal(ev.provider, "codex");
      assert.equal(ev.recordedVia, "scan");
      assert.equal(ev.source, "claude");
      assert.equal(ev.triggerMessage, "help with github");
      assert.ok((ev.injectedTokens ?? 0) > 0);
    });

    it("marks source as user when the trigger message explicitly names the skill with $name", async () => {
      const file = join(home, "sess2.jsonl");
      await writeFile(
        file,
        jsonl([
          { type: "session_meta", payload: { id: "sess-explicit", cwd: "/repo" } },
          {
            type: "response_item",
            timestamp: "2026-04-19T22:13:00.000Z",
            payload: { type: "message", role: "user", content: [{ type: "text", text: "please use $github now" }] },
          },
          {
            type: "response_item",
            timestamp: "2026-04-19T22:13:36.000Z",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call_1",
              arguments: JSON.stringify({ cmd: `cat ${skillPath}` }),
            },
          },
        ])
      );

      const skills = await codexProvider.listInstalledSkills();
      const events = await codexProvider.extractInvocationsFromFile!(file, skills, {});
      assert.equal(events.length, 1);
      assert.equal(events[0]!.source, "user");
    });

    it("also detects custom_tool_call entries via the `input` field", async () => {
      const file = join(home, "sess3.jsonl");
      await writeFile(
        file,
        jsonl([
          { type: "session_meta", payload: { id: "sess-custom" } },
          {
            type: "response_item",
            timestamp: "2026-04-19T22:13:36.000Z",
            payload: { type: "custom_tool_call", call_id: "call_2", input: `read ${skillPath}` },
          },
        ])
      );

      const skills = await codexProvider.listInstalledSkills();
      const events = await codexProvider.extractInvocationsFromFile!(file, skills, {});
      assert.equal(events.length, 1);
      assert.equal(events[0]!.skillName, "github");
    });

    it("matches a Windows-style backslash path even though `arguments` JSON-double-escapes it (regression, cross-platform)", async () => {
      // `function_call.arguments` is itself a JSON-encoded string (OpenAI's function-calling
      // convention, confirmed against real Codex rollout files) — a `\`-containing path
      // embedded in it is therefore escaped one level deeper (`\\`) than the raw filesystem
      // path. This only breaks on real Windows paths, so it's regression-tested here with a
      // synthetic Windows-style SkillDef instead of relying on Windows CI to catch it.
      const windowsSkill = { name: "pdf", description: "PDF tools", path: "C:\\Users\\alice\\.codex\\skills\\pdf\\SKILL.md" };
      const file = join(home, "sess-win.jsonl");
      await writeFile(
        file,
        jsonl([
          { type: "session_meta", payload: { id: "sess-win" } },
          {
            type: "response_item",
            timestamp: "2026-04-19T22:13:36.000Z",
            payload: {
              type: "function_call",
              name: "exec_command",
              call_id: "call_win",
              // Simulates the real double-encoding: JSON.stringify of the inner {cmd: ...}
              // object, itself embedded as a string value that jsonl() stringifies again.
              arguments: JSON.stringify({ cmd: `type ${windowsSkill.path}` }),
            },
          },
        ])
      );

      const events = await codexProvider.extractInvocationsFromFile!(file, [windowsSkill], {});
      assert.equal(events.length, 1);
      assert.equal(events[0]!.skillName, "pdf");
    });

    it("ignores tool calls that don't reference any known skill path", async () => {
      const file = join(home, "sess4.jsonl");
      await writeFile(
        file,
        jsonl([
          { type: "session_meta", payload: { id: "sess-unrelated" } },
          {
            type: "response_item",
            timestamp: "2026-04-19T22:13:36.000Z",
            payload: { type: "function_call", name: "exec_command", call_id: "call_3", arguments: JSON.stringify({ cmd: "ls -la" }) },
          },
        ])
      );

      const skills = await codexProvider.listInstalledSkills();
      const events = await codexProvider.extractInvocationsFromFile!(file, skills, {});
      assert.equal(events.length, 0);
    });

    it("returns an empty array immediately when no skills are installed", async () => {
      process.env["CC_CODEX_HOME"] = join(home, "empty-home");
      const file = join(home, "sess5.jsonl");
      await writeFile(file, jsonl([{ type: "session_meta", payload: { id: "sess-x" } }]));
      const events = await codexProvider.extractInvocationsFromFile!(file, [], {});
      assert.equal(events.length, 0);
    });

    it("returns an empty array when the file has no session_meta entry", async () => {
      const file = join(home, "sess6.jsonl");
      await writeFile(file, jsonl([{ type: "response_item", payload: { type: "message", role: "user" } }]));
      const skills = await codexProvider.listInstalledSkills();
      const events = await codexProvider.extractInvocationsFromFile!(file, skills, {});
      assert.equal(events.length, 0);
    });
  });

  describe("hookInfo", () => {
    it("always points at CC_CODEX_HOME/hooks.json regardless of project scope", () => {
      assert.equal(codexProvider.hookInfo(false).settingsPath, join(home, "hooks.json"));
      assert.equal(codexProvider.hookInfo(true).settingsPath, join(home, "hooks.json"));
      assert.equal(codexProvider.hookInfo(false).format, "json");
    });
  });
});
