import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CC_HOOK_COMMAND } from "./hooks.js";

// The repository root doubles as a Claude Code plugin marketplace
// (`/plugin marketplace add revo1290/cc-skill-trace`). These checks keep the
// two manifests loadable without needing the `claude` CLI in CI; the
// authoritative check is `claude plugin validate .`.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function readJson(rel: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(repoRoot, rel), "utf-8")) as Record<string, unknown>;
}

describe("Claude Code plugin manifests", () => {
  it("marketplace lists the repo-root plugin under the manifest's own name", async () => {
    const marketplace = await readJson(".claude-plugin/marketplace.json");
    const plugin = await readJson(".claude-plugin/plugin.json");
    assert.equal(typeof marketplace.name, "string");
    assert.ok(marketplace.owner, "marketplace.json requires an owner");
    const entries = marketplace.plugins as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    const [entry] = entries;
    // A differing entry name breaks `/plugin install <manifest-name>@...`.
    assert.equal(entry?.name, plugin.name);
    assert.equal(entry?.source, "./");
  });

  it("plugin name is kebab-case and avoids Anthropic-reserved prefixes", async () => {
    const { name } = await readJson(".claude-plugin/plugin.json");
    assert.match(String(name), /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.doesNotMatch(String(name), /^(claude|anthropic|anthropics|cc-plugin)-/);
  });

  it("every skills path resolves to a folder holding the bundled SKILL.md", async () => {
    const { skills } = await readJson(".claude-plugin/plugin.json");
    const paths = Array.isArray(skills) ? skills : [skills];
    assert.ok(paths.length > 0);
    for (const p of paths) {
      assert.match(String(p), /^\.\//, `component paths must start with ./ (got ${p})`);
      const skillMd = join(repoRoot, String(p), "SKILL.md");
      assert.ok((await stat(skillMd)).isFile(), `${skillMd} is missing`);
    }
  });

  it("ships no hooks, so it can't double-record alongside `cc-skill-trace install`", async () => {
    const plugin = await readJson(".claude-plugin/plugin.json");
    assert.equal(plugin.hooks, undefined);
    await assert.rejects(stat(join(repoRoot, "hooks", "hooks.json")));
    // Sanity: the hook command `install` writes is not smuggled in anywhere.
    const raw = await readFile(join(repoRoot, ".claude-plugin", "plugin.json"), "utf-8");
    assert.ok(!raw.includes(CC_HOOK_COMMAND));
  });

  it("omits version so the plugin tracks main instead of pinning a stale SKILL.md", async () => {
    const plugin = await readJson(".claude-plugin/plugin.json");
    assert.equal(plugin.version, undefined);
  });
});
