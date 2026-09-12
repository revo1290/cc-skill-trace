# Contributing to cc-skill-trace

Thank you for your interest in contributing!  
Please read our [Code of Conduct](./CODE_OF_CONDUCT.md) before participating. For questions, see [SUPPORT.md](./SUPPORT.md).

## Getting started

```bash
git clone https://github.com/revo1290/cc-skill-trace.git
cd cc-skill-trace
npm install
npm run build
npm test
```

## Development workflow

```bash
npm run dev         # watch mode (recompiles on save)
npm run typecheck   # type-check without emitting
npm run lint        # biome lint
npm run format:check  # biome format check (npm run format to auto-fix)
npm test            # full test suite (includes CLI integration tests)
npm run test:unit   # unit tests only, skips the subprocess-spawning CLI integration suite
```

The CLI can be tested locally with:
```bash
node dist/cli/index.js show
node dist/cli/index.js --help
```

Or directly from source without building, via `tsx`:
```bash
node --import tsx/esm src/cli/index.ts show
```

To test install/uninstall/hook-capture without touching your real Claude Code
settings, sandbox `HOME`, `CC_STORE_DIR` and `CC_PROJECTS_DIR`:
```bash
HOME=/tmp/cc-sandbox CC_STORE_DIR=/tmp/cc-sandbox/store CC_PROJECTS_DIR=/tmp/cc-sandbox/projects \
  node dist/cli/index.js install
```

## Submitting changes

1. **Fork** the repository and create a feature branch from `main`.
2. Make your changes and add tests for any new logic.
3. Run `npm test` and `npm run typecheck` — both must pass.
4. Open a pull request with a clear description of what changed and why.

## Commit and pull-request titles

This project follows [Conventional Commits](https://www.conventionalcommits.org).
Pull requests are squash-merged, so **the PR title becomes the commit subject on
`main`** — CI checks it, and the release workflow reads it when generating the
changelog.

```
<type>(<optional scope>): <description>
```

```
feat: add `report --watch` for a live-updating HTML report (#228)
fix(scan): skip session files that disappear mid-scan
docs: document the live report in the README
chore(deps): bump commander from 12.1.0 to 15.0.0
feat(store)!: drop the v1 event format        # "!" marks a breaking change
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
`chore`, `style`, `revert`. Keep the description lowercase, under 100
characters in total, and without a trailing period.

Check a title locally before pushing:

```bash
node scripts/check-pr-title.mjs "feat: add a thing"
```

### Changelog

`CHANGELOG.md` is still written by hand — add your entry under
`## [Unreleased]` when a change is user-facing. At release time the workflow
promotes whatever is there to the new version heading, and only falls back to
grouping commit subjects when the section was left empty:

```bash
node scripts/generate-changelog.mjs 3.1.0            # preview the generated section
node scripts/generate-changelog.mjs 3.1.0 --write    # what CI does at release time
```

## Code style

- TypeScript strict mode is enforced (`"strict": true` in tsconfig).
- No external runtime dependencies beyond `chalk` and `commander`.
- The hook (`hook-capture`) must **never** block Claude Code — catch all exceptions and always exit 0.
- Keep the event store format (`SkillInvocationEvent`) backwards-compatible.

## Reporting bugs

Use [GitHub Issues](https://github.com/revo1290/cc-skill-trace/issues).
For security issues, see [SECURITY.md](./SECURITY.md) instead.
