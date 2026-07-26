import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Read the bundled SKILL.md next to this test file. Normalize CRLF → LF so a
// Windows checkout with core.autocrlf=true (which rewrites the file's line
// endings) doesn't break the ```bash fence regex below.
const skillMd = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "SKILL.md"),
  "utf-8"
).replace(/\r\n/g, "\n");

// Extract the first fenced ```bash block — this is the install check run by /skill-trace.
const bashBlock = skillMd.match(/```bash\n([\s\S]*?)```/)?.[1] ?? "";

describe("SKILL.md install check", () => {
  it("has a bash code block", () => {
    assert.ok(bashBlock.length > 0, "expected a ```bash block in SKILL.md");
  });

  // On Windows native, `which` does not exist (the equivalent is `where`). Without a
  // `where` fallback the check always prints "NOT INSTALLED" even when the CLI is
  // installed. (#170)
  it("falls back to `where` for cross-platform (Windows) detection", () => {
    assert.match(bashBlock, /which cc-skill-trace/, "expected a `which` lookup");
    assert.match(
      bashBlock,
      /where cc-skill-trace/,
      "expected a `where` fallback for Windows native shells (#170)"
    );
  });

  it("checks `which` before `where` so mac/Linux behavior is unchanged", () => {
    const whichIdx = bashBlock.indexOf("which cc-skill-trace");
    const whereIdx = bashBlock.indexOf("where cc-skill-trace");
    assert.ok(whichIdx >= 0 && whereIdx > whichIdx, "`where` must come after `which`");
  });

  it("still shows the NOT INSTALLED hint as the final fallback", () => {
    const whereIdx = bashBlock.indexOf("where cc-skill-trace");
    const notInstalledIdx = bashBlock.indexOf("NOT INSTALLED");
    assert.ok(
      notInstalledIdx > whereIdx,
      "the NOT INSTALLED branch must remain the last fallback"
    );
  });
});
