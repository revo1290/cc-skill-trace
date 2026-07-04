import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVersion, FALLBACK_VERSION } from "./version.js";

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cc-skill-trace-version-"));
}

test("resolves version from package.json in the start directory", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: "cc-skill-trace", version: "1.2.3" })
    );
    assert.equal(resolveVersion(dir), "1.2.3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("walks up to find package.json when start dir has none (dist structure change)", async () => {
  const root = await makeTempDir();
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "cc-skill-trace", version: "4.5.6" })
    );
    // Simulate a deeper/relocated compiled layout, e.g. dist/cli/ or a bundle.
    const deep = join(root, "dist", "cli", "chunks");
    await mkdir(deep, { recursive: true });
    assert.equal(resolveVersion(deep), "4.5.6");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prefers the cc-skill-trace manifest over a nearer, differently-named one", async () => {
  const root = await makeTempDir();
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "cc-skill-trace", version: "9.9.9" })
    );
    // A nearer package.json belonging to something else (e.g. a bundler) must
    // not shadow the real package version.
    const nested = join(root, "node_modules", "other");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "package.json"),
      JSON.stringify({ name: "other-pkg", version: "0.0.1" })
    );
    assert.equal(resolveVersion(nested), "9.9.9");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns fallback instead of throwing when no package.json exists", async () => {
  const dir = await makeTempDir();
  try {
    // Empty temp dir with no package.json anywhere up to the filesystem root.
    assert.equal(resolveVersion(dir), FALLBACK_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("returns fallback (does not throw) when package.json is malformed", async () => {
  const dir = await makeTempDir();
  try {
    await writeFile(join(dir, "package.json"), "{ this is not valid json");
    assert.equal(resolveVersion(dir), FALLBACK_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
