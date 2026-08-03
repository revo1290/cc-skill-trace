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

// #82: /skill-trace should pass user-provided arguments through to the CLI
// instead of always running the fixed `-n 15` command.
describe("SKILL.md argument passthrough (#82)", () => {
  it("references the {{args}} placeholder", () => {
    assert.match(
      bashBlock,
      /\{\{args\}\}/,
      "expected the bash block to read Claude Code's {{args}} placeholder"
    );
  });

  it("falls back to the default `-n 15` command when no args are given", () => {
    assert.match(
      bashBlock,
      /cc-skill-trace show --scan --terse -n 15/,
      "expected the empty-args branch to keep the previous default behavior"
    );
  });

  it("passes non-empty args through to `cc-skill-trace show --scan --terse`", () => {
    assert.match(
      bashBlock,
      /cc-skill-trace show --scan --terse \$ARGS/,
      "expected user-supplied args to be forwarded to the show command"
    );
  });

  it("keeps the not-installed check as an exit-0 no-op regardless of args (never blocks Claude Code)", () => {
    assert.match(
      bashBlock,
      /NOT INSTALLED[^\n]*exit 0/,
      "expected the not-installed branch to still exit 0"
    );
  });
});
