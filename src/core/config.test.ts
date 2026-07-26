import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStoreDir, loadConfig, loadState, saveConfig, saveState } from "./config.js";

describe("config", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "cc-skill-trace-config-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("getStoreDir (#95)", () => {
    it("defaults to ~/.cc-skill-trace when CC_STORE_DIR is unset", () => {
      const prev = process.env["CC_STORE_DIR"];
      delete process.env["CC_STORE_DIR"];
      try {
        assert.ok(getStoreDir().endsWith(".cc-skill-trace"));
      } finally {
        if (prev != null) process.env["CC_STORE_DIR"] = prev;
      }
    });

    it("honors CC_STORE_DIR when set", () => {
      const prev = process.env["CC_STORE_DIR"];
      process.env["CC_STORE_DIR"] = "/tmp/custom-store";
      try {
        assert.equal(getStoreDir(), "/tmp/custom-store");
      } finally {
        if (prev != null) process.env["CC_STORE_DIR"] = prev;
        else delete process.env["CC_STORE_DIR"];
      }
    });
  });

  describe("loadConfig (#131)", () => {
    it("returns built-in defaults when config.json is absent", async () => {
      const config = await loadConfig(join(dir, "missing"));
      assert.equal(config.captureTriggerMessages, true);
      assert.equal(config.redactTriggerMessages, false);
      assert.equal(config.triggerMessageMaxLen, 300);
      assert.equal(config.maxWidth, 100);
    });

    it("returns defaults for a corrupt config.json instead of throwing", async () => {
      const corruptDir = join(dir, "corrupt");
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(corruptDir, { recursive: true });
      await writeFile(join(corruptDir, "config.json"), "NOT JSON", "utf-8");
      const config = await loadConfig(corruptDir);
      assert.equal(config.captureTriggerMessages, true);
    });

    it("round-trips values written by saveConfig", async () => {
      const rtDir = join(dir, "roundtrip");
      await saveConfig({ autoPruneDays: 30, captureTriggerMessages: false }, rtDir);
      const config = await loadConfig(rtDir);
      assert.equal(config.autoPruneDays, 30);
      assert.equal(config.captureTriggerMessages, false);
    });

    it("preserves unrelated existing keys on partial saveConfig calls", async () => {
      const partialDir = join(dir, "partial");
      await saveConfig({ autoPruneDays: 10 }, partialDir);
      await saveConfig({ webhookUrl: "https://example.com/hook" }, partialDir);
      const raw = JSON.parse(await readFile(join(partialDir, "config.json"), "utf-8"));
      assert.equal(raw.autoPruneDays, 10);
      assert.equal(raw.webhookUrl, "https://example.com/hook");
    });

    it("CC_MAX_WIDTH env var overrides config.json (#195)", async () => {
      const envDir = join(dir, "env-width");
      await saveConfig({ maxWidth: 80 }, envDir);
      const prev = process.env["CC_MAX_WIDTH"];
      process.env["CC_MAX_WIDTH"] = "60";
      try {
        const config = await loadConfig(envDir);
        assert.equal(config.maxWidth, 60);
      } finally {
        if (prev != null) process.env["CC_MAX_WIDTH"] = prev;
        else delete process.env["CC_MAX_WIDTH"];
      }
    });

    it("CC_NO_UPDATE_CHECK=1 disables update checks regardless of config.json", async () => {
      const envDir = join(dir, "env-update");
      await saveConfig({ updateCheck: true }, envDir);
      const prev = process.env["CC_NO_UPDATE_CHECK"];
      process.env["CC_NO_UPDATE_CHECK"] = "1";
      try {
        const config = await loadConfig(envDir);
        assert.equal(config.updateCheck, false);
      } finally {
        if (prev != null) process.env["CC_NO_UPDATE_CHECK"] = prev;
        else delete process.env["CC_NO_UPDATE_CHECK"];
      }
    });
  });

  describe("loadState / saveState", () => {
    it("returns {} when state.json is absent", async () => {
      assert.deepEqual(await loadState(join(dir, "no-state")), {});
    });

    it("merges patches across multiple saveState calls", async () => {
      const stateDir = join(dir, "state");
      await saveState({ lastScanMtimeMs: 100 }, stateDir);
      await saveState({ lastAutoPruneAt: 200 }, stateDir);
      const state = await loadState(stateDir);
      assert.equal(state.lastScanMtimeMs, 100);
      assert.equal(state.lastAutoPruneAt, 200);
    });
  });
});
