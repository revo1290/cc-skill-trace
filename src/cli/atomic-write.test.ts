import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSettingsAtomic } from "./atomic-write.js";

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("writeSettingsAtomic", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "cc-skill-trace-atomic-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes JSON to the target path and leaves no tmp file", async () => {
    const target = join(dir, "settings.json");
    await writeSettingsAtomic(target, { hooks: { PreToolUse: [] } });

    const written = JSON.parse(await readFile(target, "utf-8"));
    assert.deepEqual(written, { hooks: { PreToolUse: [] } });
    assert.equal(await exists(target + ".tmp"), false);
  });

  it("backs up the previous file as <path>.bak", async () => {
    const target = join(dir, "backup.json");
    await writeFile(target, JSON.stringify({ version: 1 }), "utf-8");
    await writeSettingsAtomic(target, { version: 2 });

    assert.deepEqual(JSON.parse(await readFile(target, "utf-8")), { version: 2 });
    assert.deepEqual(JSON.parse(await readFile(target + ".bak", "utf-8")), { version: 1 });
  });

  it("removes the leftover tmp file when rename fails (#184)", async () => {
    // Make the target an existing directory so rename(tmp, path) fails.
    const target = join(dir, "as-a-dir");
    await mkdir(target);

    await assert.rejects(() => writeSettingsAtomic(target, { some: "data" }));

    // The tmp file must not be left behind after the failed rename.
    assert.equal(await exists(target + ".tmp"), false);
  });
});
