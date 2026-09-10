#!/usr/bin/env node
// Changelog generation from Conventional Commits (#114).
//
// The release workflow calls this after bumping the version. It deliberately
// does NOT overwrite hand-written notes: if `## [Unreleased]` already has
// content, that content is promoted to the new version heading untouched, and
// commits are only used to fill an empty Unreleased section. The rich,
// hand-edited entries this project's changelog is full of therefore always win.
//
// Usage:
//   node scripts/generate-changelog.mjs 3.1.0            # print the section
//   node scripts/generate-changelog.mjs 3.1.0 --write    # update CHANGELOG.md
//   node scripts/generate-changelog.mjs 3.1.0 --from v3.0.0

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMergeOrRevertHeader, parseCommitHeader } from "./conventional-commit.mjs";

/** Commit type → changelog section, in output order. */
const SECTION_BY_TYPE = {
  feat: "Added",
  refactor: "Changed",
  revert: "Changed",
  fix: "Fixed",
  perf: "Performance",
  docs: "Documentation",
  test: "Internal",
  build: "Internal",
  ci: "Internal",
  chore: "Internal",
  style: "Internal",
};

const SECTION_ORDER = ["Added", "Changed", "Fixed", "Performance", "Documentation", "Internal"];

/**
 * Group commit subjects into changelog sections.
 *
 * @param {string[]} subjects
 * @returns {{breaking: string[], sections: Record<string, string[]>}}
 */
export function groupCommits(subjects) {
  const breaking = [];
  /** @type {Record<string, string[]>} */
  const sections = {};

  for (const subject of subjects) {
    const trimmed = String(subject).trim();
    if (!trimmed || isMergeOrRevertHeader(trimmed)) continue;
    const parsed = parseCommitHeader(trimmed);
    if (!parsed) continue; // unparseable subjects are left out rather than guessed at

    const entry = parsed.scope ? `\`${parsed.scope}\`: ${parsed.description}` : parsed.description;
    if (parsed.breaking) {
      if (!breaking.includes(entry)) breaking.push(entry);
      continue;
    }
    const section = SECTION_BY_TYPE[parsed.type];
    if (!section) continue;
    const bucket = (sections[section] ??= []);
    if (!bucket.includes(entry)) bucket.push(entry);
  }

  return { breaking, sections };
}

/**
 * Render grouped commits as the body of a changelog release section.
 *
 * @param {ReturnType<typeof groupCommits>} groups
 * @returns {string} Markdown, without the `## [version]` heading.
 */
export function renderReleaseBody(groups) {
  const parts = [];
  if (groups.breaking.length) {
    parts.push(`### Breaking changes\n${groups.breaking.map((e) => `- ${e}`).join("\n")}`);
  }
  for (const section of SECTION_ORDER) {
    const entries = groups.sections[section];
    if (!entries?.length) continue;
    parts.push(`### ${section}\n${entries.map((e) => `- ${e}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Insert a new release section into CHANGELOG.md text.
 *
 * Hand-written `## [Unreleased]` content is promoted as-is; `generatedBody` is
 * only used when that section is empty.
 *
 * @param {string} text Current CHANGELOG.md contents.
 * @param {{version: string, date: string, generatedBody?: string}} opts
 * @returns {string}
 */
export function updateChangelog(text, { version, date, generatedBody = "" }) {
  const heading = "## [Unreleased]";
  const start = text.indexOf(heading);
  if (start === -1) throw new Error("CHANGELOG.md has no '## [Unreleased]' section");

  const bodyStart = start + heading.length;
  const nextHeading = text.indexOf("\n## [", bodyStart);
  const bodyEnd = nextHeading === -1 ? text.length : nextHeading;
  const existing = text.slice(bodyStart, bodyEnd).trim();

  const body = existing || generatedBody.trim() || "_No notable changes._";
  const released = `${heading}\n\n## [${version}] — ${date}\n\n${body}\n`;
  let out = text.slice(0, start) + released + text.slice(bodyEnd).replace(/^\n+/, "\n");

  // Keep the link-reference block at the bottom in step, when there is one.
  const unreleasedLink = /^\[Unreleased\]: (.+)\/compare\/(v[^.]+(?:\.[^.]+)*)\.\.\.HEAD$/m;
  const link = unreleasedLink.exec(out);
  if (link) {
    const [, repoUrl, previousTag] = link;
    out = out.replace(
      unreleasedLink,
      `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD\n` +
        `[${version}]: ${repoUrl}/compare/${previousTag}...v${version}`
    );
  }
  return out;
}

/** Commit subjects between `from` (exclusive) and HEAD. */
function commitSubjects(from) {
  const range = from ? [`${from}..HEAD`] : [];
  const out = execFileSync("git", ["log", "--pretty=%s", ...range], { encoding: "utf-8" });
  return out.split("\n").filter(Boolean);
}

/** Most recent tag, or `null` when the repository has none yet. */
function latestTag() {
  try {
    return execFileSync("git", ["describe", "--tags", "--abbrev=0"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function main(argv) {
  const args = argv.slice(2);
  const version = args.find((a) => !a.startsWith("--"));
  if (!version) {
    console.error("Usage: node scripts/generate-changelog.mjs <version> [--from <tag>] [--write]");
    process.exit(2);
  }
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const from = flag("from") ?? latestTag();
  const date = flag("date") ?? new Date().toISOString().slice(0, 10);
  const body = renderReleaseBody(groupCommits(commitSubjects(from)));

  if (!args.includes("--write")) {
    console.log(body || "_No notable changes._");
    return;
  }

  const path = join(process.cwd(), "CHANGELOG.md");
  const current = readFileSync(path, "utf-8");
  const updated = updateChangelog(current, { version, date, generatedBody: body });
  writeFileSync(path, updated, "utf-8");
  const promoted = current.split("## [Unreleased]")[1]?.split("\n## [")[0]?.trim();
  console.log(
    promoted
      ? `✓ CHANGELOG.md: promoted the hand-written Unreleased notes to [${version}]`
      : `✓ CHANGELOG.md: generated [${version}] from commits since ${from ?? "the first commit"}`
  );
}

// Only run the CLI when executed directly, so the tests can import the helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv);
}
