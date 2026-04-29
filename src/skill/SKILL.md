---
name: skill-trace
description: >
  Skill invocation history for Claude Code (auto vs user).
  Invoke ONLY on explicit user request about skill history or /skill-trace.
  Skip general skill or token questions.
user-invocable: true
---

```bash
which cc-skill-trace 2>/dev/null || { echo "NOT INSTALLED: npm install -g cc-skill-trace && cc-skill-trace install"; exit 0; }
cc-skill-trace show --scan --terse -n 15 2>/dev/null
```

Show output verbatim. 2-sentence summary: auto-trigger rate; any skill auto-fired without clear user intent (suggest narrowing its `description:`). Offer: `report`, `--skill <name>`, `--since YYYY-MM-DD`.
