import assert from "node:assert/strict";
import { describe, it } from "node:test";
// @ts-expect-error - plain .mjs CI helper, no type declarations
import {
  groupCommits,
  renderReleaseBody,
  updateChangelog,
} from "../../scripts/generate-changelog.mjs";

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [3.0.0] — 2026-08-02

### Added
- multi-provider support

[Unreleased]: https://github.com/revo1290/cc-skill-trace/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/revo1290/cc-skill-trace/compare/v2.0.0...v3.0.0
`;

describe("groupCommits (#114)", () => {
  it("routes each commit type to its changelog section", () => {
    const groups = groupCommits([
      "feat: add report --watch (#228)",
      "fix(scan): skip unreadable files",
      "perf: stream the store",
      "docs: expand the README",
      "chore(deps): bump commander",
      "refactor: split the report module",
    ]);
    assert.deepEqual(groups.sections.Added, ["add report --watch (#228)"]);
    assert.deepEqual(groups.sections.Fixed, ["`scan`: skip unreadable files"]);
    assert.deepEqual(groups.sections.Performance, ["stream the store"]);
    assert.deepEqual(groups.sections.Documentation, ["expand the README"]);
    assert.deepEqual(groups.sections.Internal, ["`deps`: bump commander"]);
    assert.deepEqual(groups.sections.Changed, ["split the report module"]);
  });

  it("collects breaking changes separately, whatever their type", () => {
    const groups = groupCommits(["feat!: drop Node 18", "fix(store)!: rewrite the format"]);
    assert.deepEqual(groups.breaking, ["drop Node 18", "`store`: rewrite the format"]);
    assert.equal(groups.sections.Added, undefined);
  });

  it("ignores merge commits and unparseable subjects instead of guessing", () => {
    const groups = groupCommits([
      "Merge pull request #230 from revo1290/release/v3.0.0",
      "some drive-by commit",
      "feat: a real one",
    ]);
    assert.deepEqual(groups.sections.Added, ["a real one"]);
    assert.equal(Object.keys(groups.sections).length, 1);
  });

  it("de-duplicates identical entries", () => {
    const groups = groupCommits(["fix: same thing", "fix: same thing"]);
    assert.deepEqual(groups.sections.Fixed, ["same thing"]);
  });
});

describe("renderReleaseBody (#114)", () => {
  it("puts breaking changes first and keeps a stable section order", () => {
    const body = renderReleaseBody(
      groupCommits(["chore: tidy", "feat!: drop Node 18", "fix: a bug", "feat: a feature"])
    );
    const order = [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(order, ["Breaking changes", "Added", "Fixed", "Internal"]);
    assert.ok(body.includes("- a feature"));
  });

  it("renders an empty string when nothing qualifies", () => {
    assert.equal(renderReleaseBody(groupCommits(["not a commit subject"])), "");
  });
});

describe("updateChangelog (#114)", () => {
  it("fills an empty Unreleased section from commits", () => {
    const out = updateChangelog(CHANGELOG, {
      version: "3.1.0",
      date: "2026-09-10",
      generatedBody: "### Added\n- a generated entry",
    });
    assert.ok(out.includes("## [Unreleased]\n\n## [3.1.0] — 2026-09-10\n\n### Added\n- a generated entry"));
    assert.ok(out.includes("## [3.0.0] — 2026-08-02"), "older releases must survive");
  });

  it("promotes hand-written Unreleased notes instead of overwriting them", () => {
    const handWritten = CHANGELOG.replace(
      "## [Unreleased]\n",
      "## [Unreleased]\n\n### Added\n- carefully worded prose that a commit log cannot reproduce\n"
    );
    const out = updateChangelog(handWritten, {
      version: "3.1.0",
      date: "2026-09-10",
      generatedBody: "### Added\n- a generated entry",
    });
    assert.ok(out.includes("carefully worded prose"));
    assert.ok(!out.includes("a generated entry"));
    // ...and Unreleased is left empty, ready for the next cycle.
    assert.ok(out.includes("## [Unreleased]\n\n## [3.1.0]"));
  });

  it("rewrites the link references at the bottom", () => {
    const out = updateChangelog(CHANGELOG, { version: "3.1.0", date: "2026-09-10" });
    assert.ok(
      out.includes("[Unreleased]: https://github.com/revo1290/cc-skill-trace/compare/v3.1.0...HEAD")
    );
    assert.ok(
      out.includes("[3.1.0]: https://github.com/revo1290/cc-skill-trace/compare/v3.0.0...v3.1.0")
    );
    assert.ok(out.includes("[3.0.0]: https://github.com/revo1290/cc-skill-trace/compare/v2.0.0...v3.0.0"));
  });

  it("falls back to a placeholder when there is nothing to say", () => {
    const out = updateChangelog(CHANGELOG, { version: "3.1.0", date: "2026-09-10" });
    assert.ok(out.includes("_No notable changes._"));
  });

  it("refuses to touch a changelog without an Unreleased section", () => {
    assert.throws(
      () => updateChangelog("# Changelog\n", { version: "1.0.0", date: "2026-09-10" }),
      /no '## \[Unreleased\]' section/
    );
  });
});
