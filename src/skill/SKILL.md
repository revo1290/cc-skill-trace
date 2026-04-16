---
name: skill-trace
description: >
  Show which Claude Code skills have been invoked in the current or recent sessions, 
  why they were triggered (the preceding user message), and a breakdown of auto vs 
  user-invoked counts. Use this skill when the user asks about skill activity, wants 
  to debug unexpected skill behavior, or wants to understand which skills Claude is 
  auto-loading. Also useful for auditing token usage from skill injections.
user-invocable: true
---

# skill-trace

You are running the `cc-skill-trace` tool to visualize skill invocation history.

## Step 1 — Check if cc-skill-trace is installed

Run this check:
```bash
which cc-skill-trace 2>/dev/null || echo "NOT_INSTALLED"
```

If it outputs `NOT_INSTALLED`, tell the user:
> cc-skill-trace is not installed. Install it with:
> ```
> npm install -g cc-skill-trace
> cc-skill-trace install
> ```
> Then restart Claude Code.

## Step 2 — Show the terminal dashboard

Run the main dashboard command:
```bash
cc-skill-trace show --scan 2>&1
```

The `--scan` flag backfills from session logs so first-run always has data.

Display the full output verbatim in a code block so the box-drawing characters render correctly.

## Step 3 — Interpret results for the user

After showing the dashboard output, add a brief summary:

- **Auto-trigger rate**: If > 80%, mention that Claude is loading many skills automatically — this costs context tokens.
- **Top skill**: Name the most-invoked skill and whether it's mostly auto or user triggered.
- **Unexpected auto-triggers**: If a skill appears auto-triggered many times without clear user intent, flag it — the skill's `description` field may be too broad.

## Step 4 — Offer follow-up actions

Offer these options:
1. `cc-skill-trace report` — open a full interactive browser dashboard with charts
2. `cc-skill-trace show --skill <name>` — drill into a specific skill
3. `cc-skill-trace show --since <YYYY-MM-DD>` — filter to a date range
4. Edit the skill's `description:` in SKILL.md to make auto-trigger more precise

## Notes

- The dashboard uses box-drawing characters and ANSI colors — always show in a fenced code block with no language tag.
- If the user asks "why did skill X fire?", run `cc-skill-trace show --skill X --cards` for the full trigger context per invocation.
- If the event store is empty and `--scan` found nothing, the hook may not be installed yet — run `cc-skill-trace install`.
