#!/usr/bin/env node
// CI gate for pull-request titles (#114).
//
// PRs land as squash merges, so the PR title becomes the commit subject on
// main — that is the string the changelog generator later reads. Validating it
// here is what keeps `main`'s history parseable.
//
// Usage: node scripts/check-pr-title.mjs "<title>"     (or set $PR_TITLE)

import { formatValidationError, validateCommitHeader } from "./conventional-commit.mjs";

const title = process.argv[2] ?? process.env.PR_TITLE ?? "";
const { ok, errors } = validateCommitHeader(title);

if (!ok) {
  console.error(formatValidationError(title, errors));
  process.exit(1);
}

console.log(`✓ PR title follows Conventional Commits: ${title}`);
