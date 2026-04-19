# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/revo1290/cc-skill-trace/releases/tag/v0.1.2
