# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅        |

Only the latest release on npm receives security fixes. Please update before reporting.

## Reporting a Vulnerability

**Do not file a public GitHub issue for security vulnerabilities.**

Report security issues by emailing **hin.ww1290@gmail.com** with the subject line:

```
[cc-skill-trace] Security: <short description>
```

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Any suggested remediation (optional)

You will receive an acknowledgement within **48 hours** and a status update within **7 days**.

## Scope

This tool runs locally on the user's machine and processes only:
- Claude Code session logs from `~/.claude/projects/`
- A local event store at `~/.cc-skill-trace/events.jsonl`

It does **not** transmit any data externally. The HTML report loads Chart.js from jsDelivr CDN.

## Out of Scope

- Vulnerabilities in Claude Code itself
- Issues requiring physical access to the user's machine
- Social engineering attacks
