---
name: skill-trace
description: >
  Show which Claude Code skills were invoked, when, and why (auto vs user).
  Invoke ONLY when the user explicitly asks about skill invocation history,
  unexpected skill triggers, or types /skill-trace.
  Do NOT invoke for general questions about skills or token usage.
user-invocable: true
---

# skill-trace

## Step 1 — Check installation

```bash
which cc-skill-trace 2>/dev/null || echo "NOT_INSTALLED"
```

If `NOT_INSTALLED`: tell the user to run `npm install -g cc-skill-trace && cc-skill-trace install` then restart Claude Code. Stop here.

## Step 2 — Show dashboard

```bash
cc-skill-trace show --scan --compact 2>&1
```

Show the output verbatim in a fenced code block (no language tag).

## Step 3 — Interpret

Provide a 2–3 line summary covering:
- Auto-trigger rate (if >80%, note it costs context tokens and skill descriptions may be too broad)
- Any skill appearing auto-triggered without clear user intent (flag as candidate for narrowing its `description:`)

Offer follow-ups: `cc-skill-trace report` for browser charts, `--skill <name>` to drill in, `--since <YYYY-MM-DD>` to filter by date.
