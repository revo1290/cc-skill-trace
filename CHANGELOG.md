# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.8] — 2026-04-22

### Changed
- Optimize SKILL.md to reduce Claude token consumption (~60% shorter: 63 → 28 lines)
  - Narrowed `description:` to prevent unintended auto-invocation
  - Switch from `show --scan` to `show --scan --compact` so Claude reads smaller output
  - Removed verbose step prose, kept only actionable instructions

## [0.1.7] — 2026-04-22

### Added
- `stats` command — daily activity bar chart and top sessions by invocation count
- Programmatic API — `import { readEvents, extractAllInvocations, buildHtmlReport, ... } from 'cc-skill-trace'`
- `package.json` `exports` field and `main`/`types` entries for library consumers

### Changed
- README fully rewritten: npm badges, complete CLI reference for all commands, Programmatic API table, `SkillInvocationEvent` schema docs

## [0.1.6] — 2026-04-21

### Added
- `export` command — export events as JSON or CSV (`--format json|csv`, `-o <file>`, stdout-friendly for piping)
- `uninstall` command — cleanly remove the capture hook from Claude Code settings (`--project` flag for project-level)
- `show --before <date>` — upper-bound date filter to complement `--since`
- `show --follow` — live-tail mode: refreshes dashboard every 2 seconds, exit with Ctrl+C
- `clear --older-than <n>d` — prune old events (e.g. `--older-than 30d`) while keeping recent ones
- `CC_PROJECTS_DIR` environment variable — override the default `~/.claude/projects` scan path
- `pruneEvents` function in store module with 3 new tests (total tests: 21 → 24)

## [0.1.5] — 2026-04-19

### Security
- Pin all GitHub Actions to commit SHAs to prevent supply chain attacks
- Add Dependabot for automated npm and Actions version updates
- Add Subresource Integrity (SRI) hash to Chart.js CDN script
- Add Content-Security-Policy meta tag to HTML report
- Add 64 KB stdin size limit in `hook-capture` to prevent memory exhaustion
- Validate `--since` option as a valid ISO date before use

### Added
- `SECURITY.md` — responsible disclosure policy
- `CONTRIBUTING.md` — contributor guide
- GitHub Issue templates (bug report, feature request)
- GitHub PR template
- `dependabot.yml` for automated dependency updates

## [0.1.4] — 2026-04-19

### Changed
- Rewrite README in English for international npm audience
- Remove `dist/` and `skills/` from git; add to `.gitignore`
- Exclude `*.test.ts` from TypeScript compilation (test artifacts no longer in `dist/`)
- Add `prepare` script so `npm install github:...` auto-builds from source
- Replace `prepublishOnly: build` with `typecheck && test` for safer publishes
- Remove redundant `release:*` scripts — CI/CD handles publishing via tags
- Fix `release.yml` tag pattern from `*.*.*` to `v*.*.*`
- Simplify and correct `.npmignore`
- Add `pull-requests: write` to Claude GitHub Actions so they can post comments
- Add author GitHub URL to `package.json`

### Fixed
- `report --scan` was appending duplicate events on every invocation
- Hardcoded `ja-JP` locale in terminal dashboard and HTML report
- Japanese UI text and `<html lang="ja">` in HTML report
- `SKILL.md` referenced non-existent `--cards` CLI flag

## [0.1.3] — 2026-04-19

### Changed
- Update `release.yml` workflow configuration

## [0.1.2] — 2026-04-17

### Added
- Initial public release
- Terminal dashboard (`cc-skill-trace show`)
- HTML report with Chart.js (`cc-skill-trace report`)
- Real-time capture via Claude Code PreToolUse hook (`cc-skill-trace install`)
- Retroactive session log scan (`cc-skill-trace scan` / `--scan`)
- `/skill-trace` Claude Code skill
- Test suite (21 tests across store, parser, format modules)
- CI workflow (Node 18, 20, 22 matrix)
- Tag-based automated release to npm via GitHub Actions

[Unreleased]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/revo1290/cc-skill-trace/releases/tag/v0.1.2
