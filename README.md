# cc-skill-trace

**Skill invocation debugger & visualizer for Claude Code**

See which Claude Code skills fired, when, and why — in your terminal or in an interactive browser dashboard.

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

### Use inside Claude Code (as a plugin)

Type `/skill-trace` in the Claude Code chat to open the dashboard and have Claude explain why each skill was auto-triggered.

---

## CLI Commands

```bash
# Terminal dashboard (default)
cc-skill-trace show

# Backfill from past session logs, then show
cc-skill-trace show --scan

# Open interactive browser dashboard with charts
cc-skill-trace report

# Filter by skill name
cc-skill-trace show --skill commit

# Filter by date
cc-skill-trace show --since 2026-04-10

# Compact one-line list
cc-skill-trace show --compact

# Register hook + skill
cc-skill-trace install             # global (~/.claude/settings.json)
cc-skill-trace install --project   # project-level (.claude/settings.json)

# Reset the event store
cc-skill-trace clear
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

### 3. Claude Code skill (`/skill-trace`)

Installing `~/.claude/skills/skill-trace/SKILL.md` lets you call `/skill-trace` from the Claude Code chat.
Claude runs the dashboard and interprets the results — explaining why an auto-trigger rate is high, which skills fire unexpectedly, and how to narrow skill descriptions.

---

## Data storage

```
~/.cc-skill-trace/
└── events.jsonl   # stored locally only — nothing is sent externally
```

---

## Requirements

- Node.js 18 or later
- Claude Code (with skill support)

---

## Releasing a new version

Releases are automated via GitHub Actions. To publish:

```bash
# Bump version and create a tag
npm version patch   # or minor / major
git push origin main --follow-tags
```

The `release.yml` workflow triggers on `v*.*.*` tags, runs the full test suite, creates a GitHub Release, and publishes to npm automatically.

---

## License

MIT © [revo1290](https://github.com/revo1290)
