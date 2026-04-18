---
name: skill-tune
description: >
  Analyze Claude Code skill invocation history (via cc-skill-trace) to identify
  over-triggering skills and suggest improved descriptions to reduce unwanted
  auto-triggers. Use when the user says skills are firing too often, Claude is
  loading too many skills automatically, a specific skill seems to trigger on
  unrelated prompts, or the user wants to audit their skill descriptions for
  precision. Requires cc-skill-trace to be installed.
---

# skill-tune

Diagnose and fix over-triggering Claude Code skills using cc-skill-trace data.

## Step 1 — Collect invocation data

```bash
cc-skill-trace show --scan 2>&1
```

If `cc-skill-trace` is not found, tell the user to install it:
```
npm install -g cc-skill-trace && cc-skill-trace install
```

## Step 2 — Identify high-frequency auto-triggers

From the dashboard output, find skills where:
- `claude` source count is high relative to `user` source count
- Auto-trigger rate > 50% of total invocations

Focus on those skills for analysis.

## Step 3 — Read the SKILL.md for each suspect skill

Skills live at `~/.claude/skills/<skill-name>/SKILL.md`. Read the frontmatter `description:` field:

```bash
cat ~/.claude/skills/<skill-name>/SKILL.md
```

Also read the trigger messages to understand what user prompts caused the auto-trigger:

```bash
cc-skill-trace show --skill <name> 2>&1
```

## Step 4 — Diagnose and rewrite

For each over-triggering skill, analyze:
- What words/phrases in the `description:` are too broad?
- Do the trigger messages actually require this skill?
- Is there overlap with another skill's description?

Write a tighter `description:` that:
1. Names the specific tool, file format, or workflow the skill handles
2. Lists concrete trigger phrases ("Use when the user asks to create a .docx", not "Use for document tasks")
3. Adds explicit exclusions if needed ("Do NOT use for general text editing")

Show the user a before/after diff and confirm before writing.

## Step 5 — Apply the fix

With the user's approval, update only the `description:` frontmatter field in the SKILL.md (do not modify the body):

```bash
# Confirm location
ls ~/.claude/skills/<skill-name>/SKILL.md
```

Then use Edit tool to make the targeted change.

## Step 6 — Verify

```bash
cc-skill-trace show 2>&1
```

Remind the user that Claude Code must be restarted for description changes to take effect.

## Notes

- `source: claude` = Claude auto-loaded the skill (this is what to reduce)
- `source: user` = user explicitly used a slash command (healthy, leave alone)
- The `triggerMessage` in event data is the user message that preceded the invocation — use it to judge whether the trigger was appropriate
- Description changes only affect future sessions; historical cc-skill-trace data is unchanged
