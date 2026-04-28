# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `list-skills` command (alias: `ls`) — list all unique skills with auto/user counts; supports `--json`, `--since`, `--before`, `--scan`
- `show --json` flag — output events as a JSON array for scripting/piping
- `CC_DEBUG=1` environment variable — enable debug logging in `hook-capture` (written to stderr)
- `CC_SCAN_CONCURRENCY` environment variable — tune the number of parallel file reads during scan (default: 8)
- `validateDateRange` guard — `--since > --before` now exits with a clear error message instead of silently returning zero results
- Terminal dashboard now shows `cwd` and `~N tokens` metadata inline when available
- `show` now warns on stderr when the installed SKILL.md is out of date with the current package version: `⚠  SKILL.md is outdated — run: cc-skill-trace install`

### Fixed
- `report`, `stats`, and `export` commands now pass filter options (`--since`, `--before`, `--skill`, `--session`) directly to `readEvents` instead of loading all events and filtering in memory — consistent with `show` and more efficient for large stores
- CSV export now quotes header column names (was quoting values but not headers)
- `export` CSV now includes the `injectedTokens` field (was missing from headers)
- CLAUDE.md architecture section corrected: `hook-capture` is a hidden sub-command in `cli/index.ts`, not a standalone `src/hook/capture.ts` file
- `install` no longer returns early when the hook is already registered — SKILL.md is now always synced to the latest bundled version regardless of hook state

### Changed
- SKILL.md compressed from ~2,455 chars (≈614 tokens) to ~781 chars (≈195 tokens) — **68% reduction in per-invocation token cost**; output capped at 15 events with `-n 15` to prevent unbounded context growth
- `install` now reports three distinct states for SKILL.md: "installed", "updated", or "already up to date"
- `report` success message now includes the event count: `✓  Report → <path>  (N events)`
- `hook-capture` debug output is now gated behind `CC_DEBUG=1` rather than always silent (stderr only, never blocks Claude Code)

## [0.1.9] — 2026-04-22

### Fixed
- Replace unbounded `Promise.all` in `extractAllInvocations` with a concurrency-limited mapper (max 8 parallel file reads) — prevents fd exhaustion on large project directories

### Added
- Scan progress indicator: `Scanning N/M files…` on stderr for `scan`, `show --scan`, `stats --scan`, `report --scan`
- `export --before <date>` filter for date-range exports (consistency with other commands)
- `report --before <date>` and `report --skill <name>` filters

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
