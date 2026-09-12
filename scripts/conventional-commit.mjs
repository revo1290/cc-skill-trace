// Zero-dependency Conventional Commits parser and validator (#114).
//
// Used by `scripts/check-pr-title.mjs` (the PR-title CI gate) and by
// `scripts/generate-changelog.mjs`. Kept as plain .mjs, like copy-skill.mjs,
// so CI can run it without a build step; its tests live in
// src/cli/conventional-commit.test.ts.

/** Commit types this project accepts, in the order they appear in a changelog. */
export const COMMIT_TYPES = [
  "feat",
  "fix",
  "perf",
  "refactor",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "style",
  "revert",
];

/** Maximum header length. Long enough for a descriptive subject, short enough
 *  to stay readable in `git log --oneline` and on GitHub. */
export const MAX_HEADER_LENGTH = 100;

const HEADER_RE = /^(?<type>[a-z]+)(?:\((?<scope>[^()]+)\))?(?<breaking>!)?: (?<description>.+)$/;

/**
 * Parse a commit header ("feat(scope)!: description").
 *
 * @param {string} header
 * @returns {{type: string, scope: string|null, breaking: boolean, description: string}|null}
 *   `null` when the header is not in Conventional Commits shape at all.
 */
export function parseCommitHeader(header) {
  const match = HEADER_RE.exec(String(header).trim());
  if (!match?.groups) return null;
  const { type, scope, breaking, description } = match.groups;
  return {
    type,
    scope: scope ?? null,
    breaking: Boolean(breaking),
    description,
  };
}

/**
 * True for headers git itself generates, which no convention applies to.
 *
 * @param {string} header
 */
export function isMergeOrRevertHeader(header) {
  return /^(Merge |Revert ")/.test(String(header).trim());
}

/**
 * Validate a commit (or squash-merge PR) header.
 *
 * @param {string} header
 * @returns {{ok: boolean, errors: string[], parsed: ReturnType<typeof parseCommitHeader>}}
 */
export function validateCommitHeader(header) {
  const subject = String(header ?? "").trim();
  const errors = [];

  if (!subject) {
    return { ok: false, errors: ["header is empty"], parsed: null };
  }
  if (isMergeOrRevertHeader(subject)) {
    return { ok: true, errors: [], parsed: null };
  }

  const parsed = parseCommitHeader(subject);
  if (!parsed) {
    return {
      ok: false,
      errors: [
        'header must look like "type(optional scope): description" ' +
          '(for example "fix(scan): skip unreadable session files")',
      ],
      parsed: null,
    };
  }

  if (!COMMIT_TYPES.includes(parsed.type)) {
    errors.push(`unknown type "${parsed.type}" — use one of: ${COMMIT_TYPES.join(", ")}`);
  }
  if (subject.length > MAX_HEADER_LENGTH) {
    errors.push(`header is ${subject.length} characters — keep it under ${MAX_HEADER_LENGTH}`);
  }
  if (parsed.description.endsWith(".")) {
    errors.push("description must not end with a period");
  }
  if (/^[A-Z][a-z]/.test(parsed.description)) {
    errors.push("description should start lowercase (proper nouns and acronyms are fine)");
  }
  if (parsed.scope !== null && parsed.scope.trim() === "") {
    errors.push("scope parentheses are empty — drop them or name a scope");
  }

  return { ok: errors.length === 0, errors, parsed };
}

/** Human-readable help shown when a header is rejected. */
export function formatValidationError(header, errors) {
  return [
    `Invalid commit header: ${JSON.stringify(header)}`,
    "",
    ...errors.map((e) => `  • ${e}`),
    "",
    "This project follows Conventional Commits (https://www.conventionalcommits.org).",
    `Allowed types: ${COMMIT_TYPES.join(", ")}`,
    "",
    "Examples:",
    "  feat: add `report --watch` for a live-updating HTML report (#228)",
    "  fix(scan): skip session files that disappear mid-scan",
    "  chore(deps): bump commander from 12.1.0 to 15.0.0",
  ].join("\n");
}
