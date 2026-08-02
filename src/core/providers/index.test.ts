import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ALL_PROVIDER_IDS, getProvider, PROVIDERS, resolveProviderId } from "./index.js";

describe("provider registry", () => {
  it("exposes exactly claude-code, codex and copilot, in that order", () => {
    assert.deepEqual(ALL_PROVIDER_IDS, ["claude-code", "codex", "copilot"]);
  });

  it("getProvider returns the matching provider with its own id", () => {
    for (const id of ALL_PROVIDER_IDS) {
      assert.equal(getProvider(id).id, id);
      assert.equal(PROVIDERS[id].id, id);
    }
  });

  it("claude-code is the only stable-confidence provider", () => {
    assert.equal(getProvider("claude-code").confidence, "stable");
    assert.equal(getProvider("codex").confidence, "best-effort");
    assert.equal(getProvider("copilot").confidence, "best-effort");
  });

  describe("resolveProviderId", () => {
    it("accepts every known provider id", () => {
      for (const id of ALL_PROVIDER_IDS) assert.equal(resolveProviderId(id), id);
    });

    it("throws a descriptive error on an unknown id", () => {
      assert.throws(() => resolveProviderId("gemini"), /Unknown provider "gemini"/);
    });
  });
});
