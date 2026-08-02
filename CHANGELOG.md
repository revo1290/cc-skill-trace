# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.0.0] — 2026-08-02

### Upgrading from 2.x

No action required. `npm install -g cc-skill-trace@latest && cc-skill-trace install` keeps working exactly as before for Claude Code — the default provider and behavior are unchanged. Existing `events.jsonl` files (v1/v2, no `provider` field) continue to be read normally; a missing `provider` is always treated as `"claude-code"`. Multi-provider support is entirely opt-in via the new `--provider` flag.

A major release: cc-skill-trace now tracks skill invocations across **Claude Code, OpenAI Codex CLI and GitHub Copilot CLI**, not just Claude Code.

### Added — multi-provider support
- New `Provider` abstraction (`src/core/providers/`) with a `confidence` level (`"stable"` or `"best-effort"`) surfaced everywhere, so it's always clear which providers' data to fully trust
- **Codex CLI** (`codex`, best-effort): retroactive `scan` of `~/.codex/sessions/**/*.jsonl` rollout files, detected empirically — Codex has no dedicated "skill" tool call, so an invocation is recognized by matching a tool call's arguments against the absolute path of a known, installed `SKILL.md` (`~/.codex/skills/**`, `~/.codex/plugins/**/skills/**`, `.agents/skills/**`); real-time `hook-capture` support via `~/.codex/hooks.json`
- **GitHub Copilot CLI** (`copilot`, best-effort): real-time `hook-capture` only (its documented camelCase hook payload — `sessionId`/`toolName`/`toolArgs`/`toolResult`) — no documented session-log format exists yet, so retroactive scanning isn't supported for this provider; skills discovered from `.github/skills/` and `~/.copilot/skills/`
- `--provider <claude-code|codex|copilot>` flag on `install`, `uninstall`, `scan`, and every filter-based command (`show`, `stats`, `export`, `report`, `diagnose`, `check`)
- `list-skills --installed --provider <id>` — list the skills actually installed on disk for a given provider (name, description, path), independent of any recorded invocations
- `status` now reports a per-provider event breakdown and hook-registration state for all three providers; `doctor` checks Codex/Copilot hook files too (best-effort, informational — their absence is never a failure)
- Event schema v3: new optional `provider` field on `SkillInvocationEvent`; per-provider scan-resume cursor (`state.json`'s `lastScanMtimeMsByProvider`) so resuming a Codex scan doesn't interact with the Claude Code cursor
- `CC_CODEX_HOME` / `CC_COPILOT_HOME` env vars to override the default `~/.codex` / `~/.copilot` locations (mirrors `CC_PROJECTS_DIR`)

### Known limitations
- Codex and Copilot integrations are genuinely **best-effort**: their hook payload shapes are built from public docs, not verified against a live hook firing (the Codex session-log detection *is* empirically verified against real rollout files, but the real-time hook path is not). If events don't show up, run `cc-skill-trace doctor` with `CC_DEBUG=1` and file an issue with what you see.
- Copilot has no retroactive `scan` — only events captured after `install --provider copilot` are recorded.
- Neither provider currently reports whether an invocation was explicitly user-requested with full confidence; Codex infers it heuristically from a `$SkillName` mention in the triggering message, Copilot's hook payload carries no signal at all so every capture is recorded as auto-triggered.

## [2.0.0] — 2026-07-26

### Upgrading from 1.x

No action required for most users — `npm install -g cc-skill-trace@latest && cc-skill-trace install` re-syncs the hooks (now Pre **and** Post) and `SKILL.md`, and existing `events.jsonl` files (v1, no `v` field) continue to be read normally alongside new v2 events. Two behavioral changes worth knowing about:
- `uninstall` now removes only cc-skill-trace's own hook entries instead of the whole `PreToolUse` array — if you were relying on the old (overly broad) removal behavior, re-check `settings.json` after upgrading.
- `scan --clear` now writes a `events.jsonl.bak` backup before clearing; harmless, but note the new file if you scripted around the store directory's contents.

A major release focused on closing out the long-standing issue backlog: new
commands for diagnosis, health-checking and CI gating; a richer event schema
(outcomes, tags, provenance); persistent configuration; a redesigned HTML
report; and a broad correctness pass across the hook, scan and install paths.

### Added — new commands
- `doctor` [`--check-store` / `--fix-store`] — validate hook registration, SKILL.md freshness and `events.jsonl` integrity; repairs corrupt/duplicate lines with an automatic backup
- `status` — one-screen summary of install state, store location, config and last scan time
- `init` — interactive setup wizard (hook scope, auto-prune, trigger capture, webhook)
- `diagnose` — flags skills that look like they're auto-triggering without clear user intent, with concrete suggestions for tightening `description:`
- `check` — CI/CD gate; exits non-zero when auto-trigger rate or invocation counts cross a threshold
- `prune --older-than <duration>` — standalone alias of `clear --older-than`, with `--dry-run`
- `tag <event-id>` — label events (`--add`/`--remove`), e.g. mark false positives
- `replay [session-id]` — step through one session's invocations interactively
- `completion <bash|zsh|fish>` — shell completion script generator
- `install --check` — report install state without changing anything (for scripts/CI)

### Added — event model & storage
- Event schema v2: `recordedVia` (hook vs. scan), `tags`, `outcome`/`durationMs` (via the new `PostToolUse` hook), versioned with a `v` field; v1 events remain readable
- Published JSON Schema for `events.jsonl` at `schemas/skill-invocation-event.schema.json`
- `~/.cc-skill-trace/config.json` for persistent settings (aliases, auto-prune, redaction, webhook, update-check, follow interval, terminal width) and `state.json` for internal bookkeeping
- `--store <dir>` / `CC_STORE_DIR` — run against an alternate event-store directory
- Cross-source dedup (`selectNewEvents`) so `scan` never double-stores an invocation already captured live by the hook
- `events.jsonl.bak` safety backup before `scan --clear`
- Store integrity checking/repair (`checkStore`/`repairStore`) and streaming reads that no longer load the whole file into memory

### Added — filtering & analysis
- Shared filter flags across `show`/`stats`/`export`/`report`/`diagnose`/`check`: `--source`, `--cwd`, `--branch`, `--grep`, `--tag`
- Human-friendly dates: `--since "yesterday"`, `"7 days ago"`, `"2 weeks ago"`, bare durations
- `parseDuration` now accepts minutes (`30min`) alongside hours/days/weeks/months/years
- `show --diff` — compare the current period against the previous one of equal length
- `stats --cost [model]` — estimate injected-token cost from measured `injectedTokens`
- `stats` streaks, hour-of-day histogram, and top working-directory breakdown
- Programmatic `analyzeAutoTriggers()` / `diffPeriods()` exported for custom tooling

### Added — output & UX
- `show --page`/`--per-page` pagination beyond the fixed 12-row recent list
- `show --group-by session`, `show --columns <list>` (compact-view column picker), `show -o <path>`
- `list-skills --sort count|name|auto`, `list-skills --session <id>`
- Skill display aliases via `config.json`
- `CC_MAX_WIDTH` terminal width cap; `NO_COLOR`/`CC_NO_COLOR` compliance for pipes and CI
- `show --follow` now guards against overlapping ticks, redraws on terminal resize, and always restores the cursor on exit
- Confirmation prompts (skippable with `--force`) on `clear`, `uninstall`, and file-overwriting `export`

### Added — HTML report
- Skill × hour-of-day heatmap and per-git-branch bar chart
- Light/dark/auto theme (`--theme`), filter/search state persisted in `localStorage`
- `--redact` to mask trigger messages before they're embedded in the file
- Keyboard-navigable, ARIA-labeled event cards; `@media print` styling for clean PDF export

### Added — export
- `export --format sql` — SQLite-compatible dump, pipeable into `sqlite3`
- `export --merge <dirs...>` — combine multiple event stores, deduped
- `export --no-bom` for POSIX tooling; CSV output is now RFC 4180-compliant (CRLF records, proper quoting)

### Fixed
- `cc-skill-trace install` failed to find the bundled `SKILL.md` when run from a real npm-installed package (path resolution assumed a layout that didn't match what `files` actually ships); the build now copies `SKILL.md` into `dist/` and install resolves it robustly with a fallback
- `writeSettingsAtomic` created a fresh `~/.claude/` directory tree instead of crashing with `ENOENT` when it didn't exist yet
- `uninstall` removed only cc-skill-trace's own hook entries, preserving any other tool's hooks in the same `settings.json`
- `hook-capture` now has a bounded stdin read timeout and a configurable size limit (`CC_MAX_STDIN_KB`), and dedups an immediate duplicate hook firing for the same skill/session
- `--version`/every command no longer crashes if the compiled `dist/` layout changes — version resolution walks up to find the correct `package.json` and falls back gracefully
- `CC_PROJECTS_DIR` with a leading `~` is now expanded to the home directory
- Non-Claude-Code `.jsonl` files under the scan directory are detected and skipped instead of being mis-parsed
- `source` (user vs. Claude) now prefers Claude Code's own `user_invoked` flag when present, falling back to trigger-text inference only when it's absent
- `vlen`/ANSI stripping now covers cursor-move, screen-clear and OSC (hyperlink/title) escape sequences, not just SGR color codes

### Changed
- `src/cli/index.ts` split into per-command modules under `src/cli/commands/`
- `package.json`: `sideEffects: false`, `engines.npm`, a `./package.json` export subpath, `funding`, and broader npm keywords for discoverability
- CI: cross-platform (macOS/Windows) job, coverage floor, `npm pack` content/size verification, `@arethetypeswrong/cli` export-map check, and a CLI startup benchmark; added OpenSSF Scorecard and Dependency Review workflows

### Added (earlier, still unreleased at the time of writing)
- `list-skills` command (alias: `ls`) — list all unique skills with auto/user counts; supports `--json`, `--since`, `--before`, `--scan`
- `show --json` flag — output events as a JSON array for scripting/piping
- `CC_DEBUG=1` environment variable — enable debug logging in `hook-capture` (written to stderr)
- `CC_SCAN_CONCURRENCY` environment variable — tune the number of parallel file reads during scan (default: 8)
- `validateDateRange` guard — `--since > --before` now exits with a clear error message instead of silently returning zero results
- Terminal dashboard now shows `cwd` and `~N tokens` metadata inline when available
- `show` now warns on stderr when the installed SKILL.md is out of date with the current package version: `⚠  SKILL.md is outdated — run: cc-skill-trace install`
- `show --terse` — ultra-compact no-ANSI output optimised for AI consumption; used by SKILL.md to minimise token cost per `/skill-trace` invocation

### Fixed
- `report`, `stats`, and `export` commands now pass filter options (`--since`, `--before`, `--skill`, `--session`) directly to `readEvents` instead of loading all events and filtering in memory — consistent with `show` and more efficient for large stores
- CSV export now quotes header column names (was quoting values but not headers)
- `export` CSV now includes the `injectedTokens` field (was missing from headers)
- CLAUDE.md architecture section corrected: `hook-capture` is a hidden sub-command in `cli/index.ts`, not a standalone `src/hook/capture.ts` file
- `install` no longer returns early when the hook is already registered — SKILL.md is now always synced to the latest bundled version regardless of hook state

### Changed
- SKILL.md compressed from ~2,455 chars (≈614 tokens) to ~637 chars (≈159 tokens) — **74% reduction in per-invocation token cost**
- `show --terse` replaces `show --compact` in SKILL.md: no ANSI, no padding, stats+events in minimal format; output capped at `-n 15`; stderr suppressed with `2>/dev/null` to eliminate scan-progress noise from tool results
- Description field shortened from ≈65 tokens to ≈42 tokens (saves tokens every session, not just on invocation)
- Total `/skill-trace` invocation cost: ~428 tokens → ~256 tokens (**40% reduction**)
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

[Unreleased]: https://github.com/revo1290/cc-skill-trace/compare/v3.0.0...HEAD
[3.0.0]: https://github.com/revo1290/cc-skill-trace/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.5...v2.0.0
[0.1.5]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/revo1290/cc-skill-trace/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/revo1290/cc-skill-trace/releases/tag/v0.1.2
