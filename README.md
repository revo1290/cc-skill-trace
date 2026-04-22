# cc-skill-trace

**Skill invocation debugger & visualizer for Claude Code**

See which Claude Code skills fired, when, and why — in your terminal or in an interactive browser dashboard.

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

  ● 14:34:55  commit     🤖 auto  "tests passed, please open a PR"
  ● 14:31:07  commit     🤖 auto  "commit this change"
  ● 14:28:44  review-pr  👤 user  "/review-pr 123"

────────────────────────────────────────────────────────────────────────────────
  cc-skill-trace report  → interactive browser dashboard
════════════════════════════════════════════════════════════════════════════════
```

---

## Installation

```bash
npm install -g cc-skill-trace
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
# Register the capture hook + /skill-trace skill in Claude Code
cc-skill-trace install

# Restart Claude Code
```

That's it. Every subsequent skill invocation is captured automatically.

### Uninstall

```bash
cc-skill-trace uninstall           # remove from global settings
cc-skill-trace uninstall --project # remove from project settings
```

### Use inside Claude Code (as a plugin)

Type `/skill-trace` in the Claude Code chat to open the dashboard and have Claude explain why each skill was auto-triggered.

---

## CLI Reference

### Dashboard & Viewing

```bash
# Terminal dashboard (default)
cc-skill-trace show

# Live-tail: refresh every 2s (Ctrl+C to exit)
cc-skill-trace show --follow

# Backfill from past session logs, then show
cc-skill-trace show --scan

# Compact one-line list
cc-skill-trace show --compact

# Filter options
cc-skill-trace show --skill commit
cc-skill-trace show --since 2026-04-01
cc-skill-trace show --since 2026-04-01 --before 2026-04-30
cc-skill-trace show --session <session-id>
cc-skill-trace show -n 100          # show last 100 events (default: 50)
```

### Statistics

```bash
# Aggregated daily activity + top sessions
cc-skill-trace stats

# Filter stats to a specific skill or date range
cc-skill-trace stats --skill commit --since 2026-04-01
cc-skill-trace stats --scan   # backfill first
```

### Browser Report

```bash
# Generate interactive HTML report and open in browser
cc-skill-trace report

# Save to custom path without opening
cc-skill-trace report -o ~/reports/skills.html --no-open

# Filter and scan first
cc-skill-trace report --since 2026-04-01 --scan
```

### Export

```bash
# Export all events as JSON (stdout — pipe-friendly)
cc-skill-trace export

# Export as CSV
cc-skill-trace export --format csv

# Save to file
cc-skill-trace export --format csv -o events.csv

# Filter before exporting
cc-skill-trace export --since 2026-04-01 --skill commit
```

### Backfill (Retroactive Scan)

```bash
# Scan ~/.claude/projects/**/*.jsonl and import past invocations
cc-skill-trace scan

# Scan only recent sessions
cc-skill-trace scan --since 2026-04-01

# Clear and rescan from scratch
cc-skill-trace scan --clear
```

### Data Management

```bash
# Clear all events
cc-skill-trace clear

# Remove events older than 30 days (keep recent)
cc-skill-trace clear --older-than 30d
cc-skill-trace clear --older-than 7d
```

### Hook Management

```bash
# Install hook + skill
cc-skill-trace install             # global (~/.claude/settings.json)
cc-skill-trace install --project   # project (.claude/settings.json)

# Remove hook
cc-skill-trace uninstall
cc-skill-trace uninstall --project
```

---

## How it works

### 1. Real-time capture (PreToolUse hook)

`cc-skill-trace install` adds the following to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Skill",
      "hooks": [{ "type": "command", "command": "cc-skill-trace hook-capture" }]
    }]
  }
}
```

Every time a skill is invoked, `hook-capture` fires and appends an event to `~/.cc-skill-trace/events.jsonl`.
It always returns `{}` and **never blocks Claude Code**.

### 2. Retroactive scan

`~/.claude/projects/**/*.jsonl` session logs are parsed to extract past skill invocations, including the user message that preceded each one (the "trigger").

Set `CC_PROJECTS_DIR` to override the default scan path:

```bash
CC_PROJECTS_DIR=/custom/path cc-skill-trace scan
```

### 3. Claude Code skill (`/skill-trace`)

Installing `~/.claude/skills/skill-trace/SKILL.md` lets you call `/skill-trace` from the Claude Code chat.
Claude runs the dashboard and interprets the results — explaining why an auto-trigger rate is high, which skills fire unexpectedly, and how to narrow skill descriptions.

---

## Programmatic API

Use cc-skill-trace as a Node.js library:

```typescript
import { readEvents, extractAllInvocations, buildHtmlReport } from "cc-skill-trace";
import type { SkillInvocationEvent } from "cc-skill-trace";

// Read stored events
const events: SkillInvocationEvent[] = await readEvents();

// Scan session logs
const past = await extractAllInvocations({ since: "2026-04-01" });

// Generate an HTML report string
const html = buildHtmlReport(events);
```

**Exported API:**

| Export | Description |
|---|---|
| `readEvents(dir?)` | Read events from the store |
| `appendEvent(event, dir?)` | Append a single event |
| `clearEvents(dir?)` | Clear the event store |
| `pruneEvents(beforeIso, dir?)` | Remove events older than ISO date |
| `extractAllInvocations(opts?)` | Scan all session logs |
| `extractInvocationsFromFile(path)` | Scan a single session file |
| `buildStats(events)` | Aggregate events by skill |
| `buildHtmlReport(events)` | Generate standalone HTML string |
| `STORE_DIR` | Default store directory path |
| `EVENTS_FILE` | Default events file path |

---

## Data storage

```
~/.cc-skill-trace/
└── events.jsonl   # stored locally only — nothing is sent externally
```

Each line is a JSON object matching `SkillInvocationEvent`:

```typescript
interface SkillInvocationEvent {
  id: string;           // unique event ID
  timestamp: string;    // ISO 8601
  sessionId: string;    // Claude Code session ID
  skillName: string;    // e.g. "commit", "review-pr"
  skillArgs?: string;   // slash command arguments
  source: "user" | "claude" | "unknown";
  triggerMessage?: string;  // user message that preceded this invocation
  cwd?: string;
  gitBranch?: string;
}
```

---

## Requirements

- Node.js 18 or later
- Claude Code (with skill support)

---

## Releasing a new version

Releases are automated via GitHub Actions. To publish:

```bash
npm version patch   # or minor / major
git push origin main --follow-tags
```

The `release.yml` workflow triggers on `v*.*.*` tags, runs the full test suite, creates a GitHub Release, and publishes to npm automatically.

---

## License

MIT © [revo1290](https://github.com/revo1290)
