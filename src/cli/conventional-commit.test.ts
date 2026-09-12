import assert from "node:assert/strict";
import { describe, it } from "node:test";
// @ts-expect-error - plain .mjs CI helper, no type declarations
import {
  COMMIT_TYPES,
  MAX_HEADER_LENGTH,
  formatValidationError,
  isMergeOrRevertHeader,
  parseCommitHeader,
  validateCommitHeader,
} from "../../scripts/conventional-commit.mjs";

describe("parseCommitHeader (#114)", () => {
  it("parses type, scope, breaking marker and description", () => {
    assert.deepEqual(parseCommitHeader("feat: add a thing"), {
      type: "feat",
      scope: null,
      breaking: false,
      description: "add a thing",
    });
    assert.deepEqual(parseCommitHeader("fix(scan): skip unreadable files"), {
      type: "fix",
      scope: "scan",
      breaking: false,
      description: "skip unreadable files",
    });
    assert.deepEqual(parseCommitHeader("feat(store)!: drop the v1 format"), {
      type: "feat",
      scope: "store",
      breaking: true,
      description: "drop the v1 format",
    });
  });

  it("returns null for headers that aren't conventional at all", () => {
    assert.equal(parseCommitHeader("just some words"), null);
    assert.equal(parseCommitHeader("feat:missing space"), null);
    assert.equal(parseCommitHeader("feat: "), null);
  });

  it("recognizes git's own merge and revert subjects", () => {
    assert.ok(isMergeOrRevertHeader("Merge pull request #230 from revo1290/release/v3.0.0"));
    assert.ok(isMergeOrRevertHeader('Revert "feat: add a thing"'));
    assert.ok(!isMergeOrRevertHeader("feat: add a thing"));
  });
});

describe("validateCommitHeader (#114)", () => {
  it("accepts the shapes this repository actually uses", () => {
    const valid = [
      "feat: expose mergeStores as a `merge` CLI command (#226) (#241)",
      "fix: add missing checkout step to npm-token-check.yml (#231)",
      "docs: translate CLAUDE.md to English (#111)",
      "chore(deps): bump commander from 12.1.0 to 15.0.0 (#233)",
      "feat(store)!: drop the v1 event format",
    ];
    for (const header of valid) {
      const result = validateCommitHeader(header);
      assert.ok(result.ok, `expected valid: ${header} — ${result.errors.join("; ")}`);
    }
  });

  it("passes merge commits through untouched", () => {
    assert.ok(validateCommitHeader("Merge pull request #230 from revo1290/release/v3.0.0").ok);
  });

  it("rejects a non-conventional header", () => {
    const result = validateCommitHeader("Add live report");
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /type\(optional scope\): description/);
  });

  it("rejects an unknown type", () => {
    const result = validateCommitHeader("feet: add a thing");
    assert.equal(result.ok, false);
    assert.match(result.errors.join(" "), /unknown type "feet"/);
  });

  it("rejects a trailing period, a capitalized description and an empty header", () => {
    assert.match(validateCommitHeader("feat: add a thing.").errors.join(" "), /period/);
    assert.match(validateCommitHeader("feat: Add a thing").errors.join(" "), /lowercase/);
    assert.deepEqual(validateCommitHeader("   ").errors, ["header is empty"]);
  });

  it("rejects an over-long header", () => {
    const header = `feat: ${"x".repeat(MAX_HEADER_LENGTH)}`;
    assert.match(validateCommitHeader(header).errors.join(" "), /keep it under/);
  });

  it("allows acronyms and identifiers at the start of a description", () => {
    assert.ok(validateCommitHeader("fix: CLI exits 0 when the store is missing").ok);
    assert.ok(validateCommitHeader("feat: SQLite backend behind a flag").ok);
  });

  it("explains itself when it rejects something", () => {
    const message = formatValidationError("nope", ["some reason"]);
    assert.match(message, /some reason/);
    assert.match(message, /Conventional Commits/);
    for (const type of COMMIT_TYPES) assert.ok(message.includes(type));
  });
});
