# cc-skill-trace

**Skill invocation debugger & visualizer for Claude Code, Codex CLI and GitHub Copilot CLI**

See which agent-CLI skills fired, when, and why — in your terminal or in an interactive browser dashboard. Claude Code support is stable; Codex CLI and GitHub Copilot CLI are best-effort (see [Multi-provider support](#multi-provider-support)).

[![CI](https://github.com/revo1290/cc-skill-trace/actions/workflows/ci.yml/badge.svg)](https://github.com/revo1290/cc-skill-trace/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/revo1290/cc-skill-trace/badge)](https://securityscorecards.dev/viewer/?uri=github.com/revo1290/cc-skill-trace)
[![npm version](https://img.shields.io/npm/v/cc-skill-trace)](https://www.npmjs.com/package/cc-skill-trace)
[![npm downloads](https://img.shields.io/npm/dm/cc-skill-trace)](https://www.npmjs.com/package/cc-skill-trace)
[![Node.js](https://img.shields.io/node/v/cc-skill-trace)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Terminal Dashboard

Run `cc-skill-trace show` to get an instant view:

```
════════════════════════════════════════════════════════════════════════════════
  🔍 cc-skill-trace ─ Skill Invocation Debugger
────────────────────────────────────────────────────────────────────────────────

    12 invocations     9 🤖 auto     3 👤 user     4 unique skills

  🤖 Auto-trigger  ████████████████████████░░░░░░  75%

────────────────────────────────────────────────────────────────────────────────

  📊 Skills

  commit       ████████████████████████  8x  6auto · 2user
  review-pr    ████████████░░░░░░░░░░░░  3x  2auto · 1user
  security     ████░░░░░░░░░░░░░░░░░░░░  1x  1auto · 0user

────────────────────────────────────────────────────────────────────────────────

  🕐 Recent invocations  (newest first)

  ●⚡ 14:34:55  commit     🤖 auto  "tests passed, please open a PR"
  ●⚡ 14:31:07  commit     🤖 auto  "commit this change"
  ●≡ 14:28:44  review-pr  👤 user  "/review-pr 123"

────────────────────────────────────────────────────────────────────────────────
  ⚡ live-captured   ≡ scan-backfilled   cc-skill-trace report  → browser dashboard
════════════════════════════════════════════════════════════════════════════════
```

---

## Installation

```bash
npm install -g cc-skill-trace
```

Or run without installing:

```bash
npx cc-skill-trace show
```

### Install from source

```bash
git clone https://github.com/revo1290/cc-skill-trace.git
cd cc-skill-trace
npm install && npm run build
npm link
```

---

## Setup

```bash
# Register the capture hooks + /skill-trace skill in Claude Code
cc-skill-trace install

# Restart Claude Code
```

That's it. Every subsequent skill invocation is captured automatically. Prefer a guided setup? Run `cc-skill-trace init` for an interactive wizard (hook scope, auto-prune, webhook).

### Updating

```bash
npm install -g cc-skill-trace@latest
cc-skill-trace install   # re-syncs the hooks and SKILL.md — safe to re-run anytime
```

The dashboard prints a one-line hint when a newer version is available on npm (checked at most once a day, silently skipped when offline).

### Uninstall

```bash
cc-skill-trace uninstall           # remove from global settings
cc-skill-trace uninstall --project # remove from project settings
```

Uninstalling removes only cc-skill-trace's own hook entries — any other tool's hooks in the same `settings.json` are left untouched. Your captured events in `~/.cc-skill-trace/` are **not** deleted; run `cc-skill-trace clear --force` if you want to remove them too.

### Use inside Claude Code (as a plugin)

Type `/skill-trace` in the Claude Code chat to open the dashboard and have Claude explain why each skill was auto-triggered.

---

## Multi-provider support

cc-skill-trace can capture skill invocations from three agent CLIs. Every command that touches events accepts `--provider <id>` (default `claude-code`); omitting it never changes existing Claude Code behavior.

| Provider | id | Confidence | Real-time (`hook-capture`) | Retroactive (`scan`) |
|---|---|---|---|---|
| Claude Code | `claude-code` | **stable** — documented `Skill` tool, PreToolUse/PostToolUse hooks | ✅ | ✅ |
| OpenAI Codex CLI | `codex` | **best-effort** — no dedicated skill tool call; detected by matching tool-call arguments against installed `SKILL.md` paths (verified against real session logs) | ✅ (unverified live) | ✅ |
| GitHub Copilot CLI | `copilot` | **best-effort** — built from public hook docs only, no local install was available to verify against | ✅ (unverified live) | ❌ (no documented session-log format) |

```bash
# Codex CLI
cc-skill-trace install --provider codex
# also requires [features].codex_hooks = true in ~/.codex/config.toml (not auto-edited)
cc-skill-trace scan --provider codex

# GitHub Copilot CLI (hook-capture only — no retroactive scan)
cc-skill-trace install --provider copilot

# Any command that filters events accepts --provider too
cc-skill-trace show --provider codex
cc-skill-trace list-skills --installed --provider copilot   # skills found on disk, not invocation counts
```

"Best-effort" means the payload/detection logic is built from documentation and (for Codex's scan path) real captured data, but has not been exercised against a live hook firing — if events don't show up after using a skill, run `cc-skill-trace doctor` and check `CC_DEBUG=1` output, then please [file an issue](https://github.com/revo1290/cc-skill-trace/issues) with what you see.

---

## CLI Reference

Every command accepts `--help` for the full option list. Filterable commands (`show`, `stats`, `export`, `report`, `diagnose`, `check`) share a common set of flags:

```bash
--since <date>      # ISO date or human phrase: "yesterday", "7 days ago", "2w"
--before <date>      # same formats
--skill <name>        --session <id>        --source claude|user
--cwd <path-prefix>    --branch <name>        --grep <regex>        --tag <tag>
```

### Dashboard & Viewing

```bash
cc-skill-trace show                      # terminal dashboard (default command)
cc-skill-trace show --follow             # live-tail, refreshes on new events (Ctrl+C to exit)
cc-skill-trace show --scan               # backfill from session logs, then show
cc-skill-trace show --compact            # one-line-per-event table
cc-skill-trace show --columns time,skill,source,session   # pick compact columns
cc-skill-trace show --json               # pipe-friendly JSON
cc-skill-trace show --group-by session   # group events by Claude Code session
cc-skill-trace show --page 2             # paginate past the first 12 recent events
cc-skill-trace show --diff --diff-window 7d   # compare this week vs. the previous one
cc-skill-trace show -o report.txt        # save the rendered (ANSI-stripped) output
cc-skill-trace show --since "3 days ago" --skill commit

cc-skill-trace replay <session-id>       # step through one session's invocations
```

### Skill Discovery & Diagnosis

```bash
cc-skill-trace list-skills               # unique skills + auto/user counts (alias: ls)
cc-skill-trace ls --sort auto            # sort by auto-trigger rate instead of count
cc-skill-trace diagnose                  # flag skills that look like they're over-triggering
cc-skill-trace check --max-auto-rate 80  # CI gate: exit 1 if the threshold is exceeded
```

### Statistics

```bash
cc-skill-trace stats                     # daily activity, streaks, hour-of-day, top sessions/dirs
cc-skill-trace stats --days 30 --limit 10
cc-skill-trace stats --cost              # estimate injected-token cost (sonnet pricing)
cc-skill-trace stats --cost opus
```

### Browser Report

```bash
cc-skill-trace report                              # generate + open in browser
cc-skill-trace report -o ~/reports/skills.html --no-open
cc-skill-trace report --theme light                # light | dark | auto (default)
cc-skill-trace report --redact                     # mask trigger messages before embedding
cc-skill-trace report --scan --since 2026-04-01
```

The report includes a skill × hour-of-day heatmap, per-branch bar chart, filter/search state persisted in `localStorage`, keyboard-navigable event cards, and print/PDF-friendly styling.

### Export

```bash
cc-skill-trace export                          # JSON to stdout
cc-skill-trace export --format csv             # RFC 4180 CSV, UTF-8 BOM by default
cc-skill-trace export --format csv --no-bom    # omit the BOM for POSIX tooling
cc-skill-trace export --format sql | sqlite3 skills.db   # pipe straight into SQLite
cc-skill-trace export --merge /path/to/other-store -o combined.json
cc-skill-trace export -o events.csv --format csv -f      # -f skips the overwrite prompt
```

### Backfill (Retroactive Scan)

```bash
cc-skill-trace scan                      # import past invocations from session logs
cc-skill-trace scan --since 2026-04-01
cc-skill-trace scan --resume             # only files touched since the last scan
cc-skill-trace scan --dry-run            # preview counts without writing
cc-skill-trace scan --watch              # keep importing new events as sessions grow
cc-skill-trace scan --clear              # back up, clear, then rescan from scratch
```

### Data Management

```bash
cc-skill-trace clear                     # delete all events (asks to confirm)
cc-skill-trace clear --older-than 30d    # prune, keeping recent events
cc-skill-trace prune --older-than 30d --dry-run   # standalone alias with a preview mode
cc-skill-trace tag <event-id> --add false-positive   # label an event (or --remove)
```

### Install / Health

```bash
cc-skill-trace install               # global hooks + skill
cc-skill-trace install --project     # project-level (.claude/settings.json)
cc-skill-trace install --check       # report install state; exit 1 if incomplete, change nothing
cc-skill-trace status                # store location, hook state, config, last scan — at a glance
cc-skill-trace doctor                # validate settings.json, SKILL.md freshness, store integrity
cc-skill-trace doctor --fix-store    # repair a corrupted/truncated events.jsonl (backs up first)
cc-skill-trace completion zsh >> ~/.zshrc   # shell completion: bash | zsh | fish
```

---

## How it works

```
┌─────────────────┐   PreToolUse/PostToolUse hooks    ┌──────────────────────┐
│   Claude Code    │ ─────────────────────────────────▶ │  hook-capture (CLI)  │
│  (Skill tool)     │  fire on every skill invocation    │  never blocks; 0-exit │
└─────────────────┘                                     └──────────┬───────────┘
                                                                     │ append
                                                                     ▼
┌──────────────────────┐   parse & backfill    ┌───────────────────────────────┐
│ ~/.claude/projects/    │ ─────────────────────▶ │  ~/.cc-skill-trace/events.jsonl │
│  **/*.jsonl session logs│  cc-skill-trace scan   │  (local only; JSON Lines)        │
└──────────────────────┘                        └───────────────┬────────────────┘
                                                                   │ read + filter
                          ┌────────────────────────────────────────┼───────────────────────┐
                          ▼                                        ▼                        ▼
                 ┌─────────────────┐                    ┌──────────────────┐      ┌──────────────────┐
                 │ terminal dashboard│                    │  HTML report       │      │  export / API      │
                 │  show / stats /   │                    │  report --theme … │      │  json / csv / sql /│
                 │  diagnose / doctor│                    │  (standalone file)│      │  programmatic API   │
                 └─────────────────┘                    └──────────────────┘      └──────────────────┘
```

### 1. Real-time capture (Pre/PostToolUse hooks)

`cc-skill-trace install` adds the following to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Skill",
      "hooks": [{ "type": "command", "command": "cc-skill-trace hook-capture" }]
    }],
    "PostToolUse": [{
      "matcher": "Skill",
      "hooks": [{ "type": "command", "command": "cc-skill-trace hook-capture --post" }]
    }]
  }
}
```

`PreToolUse` fires when a skill is invoked and appends an event to `~/.cc-skill-trace/events.jsonl`; `PostToolUse` fires when it finishes and records the outcome (`ok`/`error`) and duration. Both always return `{}` and **never block Claude Code** — any internal error is swallowed and logged only when `CC_DEBUG=1`.

> **Note:** Real-time events captured by `hook-capture` do not include `triggerMessage` (the preceding user message) unless you also run `cc-skill-trace scan` to backfill it from session logs.

### 2. Retroactive scan

`~/.claude/projects/**/*.jsonl` session logs are parsed to extract past skill invocations, including the user message that preceded each one (the "trigger"). Scanned events are matched against already-captured hook events by session, skill, args and a time window — so backfilling never creates duplicates.

### 3. Claude Code skill (`/skill-trace`)

Installing `~/.claude/skills/skill-trace/SKILL.md` lets you call `/skill-trace` from the Claude Code chat. Claude runs the dashboard and interprets the results — explaining why an auto-trigger rate is high, which skills fire unexpectedly, and how to narrow skill descriptions.

---

## Configuration

Persistent settings live in `~/.cc-skill-trace/config.json` (created by `cc-skill-trace init`, or hand-edited):

```json
{
  "aliases": { "raw-skill-name": "Pretty Display Name" },
  "autoPruneDays": 90,
  "captureTriggerMessages": true,
  "redactTriggerMessages": false,
  "triggerMessageMaxLen": 300,
  "updateCheck": true,
  "followIntervalMs": 2000,
  "maxWidth": 100,
  "webhookUrl": "https://example.com/hook",
  "webhookTimeoutMs": 1500
}
```

All fields are optional; environment variables (below) override the equivalent config value.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `CC_PROJECTS_DIR` | `~/.claude/projects` | Override the scan directory for session logs (`~` is expanded) |
| `CC_CODEX_HOME` | `~/.codex` | Override the Codex CLI home directory used for `--provider codex` |
| `CC_COPILOT_HOME` | `~/.copilot` | Override the Copilot CLI home directory used for `--provider copilot` |
| `CC_STORE_DIR` | `~/.cc-skill-trace` | Override the event-store directory (same as `--store`) |
| `CC_DEBUG` | _(unset)_ | Set to `1` to enable debug logging (also enabled by `--verbose`) |
| `CC_SCAN_CONCURRENCY` | `8` | Number of session files to read in parallel during scan |
| `CC_MAX_STDIN_KB` | `64` | Max size accepted by `hook-capture`'s stdin read |
| `CC_MAX_WIDTH` | `100` | Terminal render width cap in columns |
| `CC_WATCH_INTERVAL_MS` | `5000` | Poll interval for `scan --watch` |
| `CC_FOLLOW_INTERVAL_MS` | `2000` | Refresh interval for `show --follow` (same as `--interval`) |
| `CC_TRIGGER_MAX_LEN` | `300` | Max stored length of `triggerMessage` |
| `CC_NO_UPDATE_CHECK` | _(unset)_ | Set to `1` to disable the daily npm update check |
| `CC_WEBHOOK_URL` | _(unset)_ | POST every captured event to this URL as JSON |
| `NO_COLOR` / `CC_NO_COLOR` | _(unset)_ | Disable ANSI colors (also auto-disabled when stdout isn't a TTY) |

---

## Programmatic API

Use cc-skill-trace as a Node.js library:

```typescript
import { readEvents, extractAllInvocations, buildHtmlReport, analyzeAutoTriggers } from "cc-skill-trace";
import type { SkillInvocationEvent } from "cc-skill-trace";

// Read stored events (supports the same filters as the CLI)
const events: SkillInvocationEvent[] = await readEvents({ since: "2026-04-01", source: "claude" });

// Scan session logs
const past = await extractAllInvocations({ since: "2026-04-01" });

// Generate an HTML report string
const html = buildHtmlReport(events, { theme: "dark", redactTriggers: false });

// Find skills that look like they're over-triggering
const findings = analyzeAutoTriggers(events);
```

See [`schemas/skill-invocation-event.schema.json`](schemas/skill-invocation-event.schema.json) for the JSON Schema of a stored event, and the published type declarations (`cc-skill-trace/dist/index.d.ts`) for the full exported surface — core read/write/analysis functions, filter helpers, config I/O, and the terminal/HTML renderers.

---

## Troubleshooting

**`cc-skill-trace: command not found` after `npm install -g`**
Check `npm config get prefix` is on your `PATH`. On Windows, ensure the npm global bin directory is in `PATH`, or use `npx cc-skill-trace`.

**No events show up after `install`**
Hooks are read once at Claude Code startup — fully restart Claude Code after `install`. Then run `cc-skill-trace doctor` to confirm both hooks are registered.

**`SKILL.md is outdated` keeps appearing**
Run `cc-skill-trace install` again; it re-syncs `~/.claude/skills/skill-trace/SKILL.md` to the version bundled with your installed CLI.

**Events store looks corrupted / commands crash reading `events.jsonl`**
Run `cc-skill-trace doctor --check-store`, then `cc-skill-trace doctor --fix-store` to repair it (a backup is written first).

**Windows / WSL specifics**
`report` opens the default browser via `cmd /c start` on native Windows and via `wslview`/PowerShell fallback under WSL. `which`-based checks in `SKILL.md` fall back to `where`. Settings writes are atomic via a temp-file rename, matching POSIX behavior as closely as Windows allows.

**Platform compatibility**: tested in CI on Linux, macOS and Windows across Node 18/20/22 — see [`ci.yml`](.github/workflows/ci.yml).

---

## Data storage

```
~/.cc-skill-trace/
├── events.jsonl   # stored locally only — nothing is sent externally (unless you set a webhook)
├── config.json    # optional persistent settings
└── state.json     # internal bookkeeping (last scan time, update-check cache)
```

Each line of `events.jsonl` is a JSON object matching `SkillInvocationEvent` — see the full [JSON Schema](schemas/skill-invocation-event.schema.json):

```typescript
interface SkillInvocationEvent {
  id: string;
  v?: number;                 // event schema version
  timestamp: string;          // ISO 8601
  sessionId: string;
  skillName: string;
  skillArgs?: string;
  source: "user" | "claude" | "unknown";
  triggerMessage?: string;
  injectedTokens?: number;
  cwd?: string;
  gitBranch?: string;
  recordedVia?: "hook" | "scan";
  tags?: string[];
  outcome?: "ok" | "error";
  durationMs?: number;
}
```

---

## Requirements

- Node.js 18 or later (18/20/22 covered in CI)
- npm 9 or later
- Claude Code (with skill support)

---

## Releasing a new version

Releases are fully automated via GitHub Actions (`release.yml`).

1. Go to **Actions → Release → Run workflow** on GitHub.
2. Enter the new version number (e.g. `2.0.0`).
3. The workflow will: bump `package.json`, open a release PR, create a signed tag, publish to npm with provenance, and create a GitHub Release.

See [CHANGELOG.md](CHANGELOG.md) for the version history and [CONTRIBUTING.md](CONTRIBUTING.md) for the local development setup.

---

## License

MIT © [revo1290](https://github.com/revo1290)
