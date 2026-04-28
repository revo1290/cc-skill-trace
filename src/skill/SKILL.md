---
name: skill-trace
description: >
  Show which Claude Code skills were invoked, when, and why (auto vs user).
  Invoke ONLY when the user explicitly asks about skill invocation history,
  unexpected skill triggers, or types /skill-trace.
  Do NOT invoke for general questions about skills or token usage.
user-invocable: true
---

```bash
which cc-skill-trace 2>/dev/null || { echo "NOT INSTALLED — run: npm install -g cc-skill-trace && cc-skill-trace install"; exit 0; }
cc-skill-trace show --scan --compact -n 15 2>&1
```

Show output verbatim in a code block. Then in 2 sentences: state the auto-trigger rate and flag any skill auto-fired without clear user intent (suggest narrowing its `description:`). Offer: `report` for charts, `--skill <name>`, `--since YYYY-MM-DD`.
