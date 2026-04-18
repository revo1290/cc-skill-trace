---
name: cc-trace-release
description: >
  Safe release workflow for cc-skill-trace maintainers. Handles version bump,
  dist/ rebuild, git tag creation and push, and npm publish in the correct order.
  Use when publishing a new version of cc-skill-trace to npm. Only for
  maintainers of the revo1290/cc-skill-trace repository working in the project
  root directory.
---

# cc-trace-release

Publish a new version of cc-skill-trace correctly: rebuild dist/, commit, tag, push, then publish.

## Pre-flight checks

Before starting, confirm:

```bash
git status          # must be clean (no uncommitted changes)
git branch          # must be on main
node --version      # v18+
npm whoami          # must be logged in to npm
```

If any check fails, resolve it before continuing.

## Step 1 — Determine the new version

Ask the user which version bump to apply: `patch`, `minor`, or `major`. Default is `patch`.

Read the current version:
```bash
node -p "require('./package.json').version"
```

Compute what the new version will be (e.g., `0.1.2` → `0.1.3` for patch). Show the user and confirm before proceeding.

## Step 2 — Build dist/

```bash
npm run build
```

Verify `dist/` updated:
```bash
ls -la dist/cli/index.js
```

## Step 3 — Update version in source files

The version string is hardcoded in `src/cli/index.ts` — update it to match the new version:

```bash
grep -n "^const VERSION" src/cli/index.ts
```

Edit `src/cli/index.ts` to set `const VERSION = "<new-version>";`, then rebuild:

```bash
npm run build
```

## Step 4 — Bump version in package.json and create git tag

Use `npm version` to atomically bump `package.json`, commit, and create the local tag:

```bash
npm version <patch|minor|major> -m "chore: release v%s"
```

This creates both a commit and a local git tag (e.g., `v0.1.3`).

## Step 5 — Stage and amend to include dist/

The `npm version` commit does not include the rebuilt `dist/`. Amend it:

```bash
git add dist/
git commit --amend --no-edit
```

This keeps the version bump and dist/ rebuild in one atomic commit, so GitHub-direct installs (`npm install github:revo1290/cc-skill-trace`) get the correct built output.

## Step 6 — Push commit and tag

```bash
git push origin main --follow-tags
```

`--follow-tags` pushes the annotated tag created by `npm version`, making it visible on GitHub and traceable to the source.

## Step 7 — Publish to npm

```bash
npm publish --access public
```

Verify the publish succeeded:
```bash
npm view cc-skill-trace version
```

## Step 8 — Confirm

Tell the user:
- The new version number
- The npm URL: `https://www.npmjs.com/package/cc-skill-trace`
- The git tag pushed (e.g., `v0.1.3`)

## Notes

- Never run `npm version` before rebuilding `dist/` — the tag would point to a commit with stale built output.
- Never use `git push` without `--follow-tags` — the tag stays local and is lost when the runner exits.
- If `npm publish` fails after the push, the tag is already on remote. Fix the npm auth issue and re-run only `npm publish --access public`.
- Do not use the auto-publish GitHub Actions workflow (`.github/workflows/npm-publish.yml`) for production releases — use this skill instead for full control.
