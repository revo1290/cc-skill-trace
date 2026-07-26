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

It does **not** transmit any data externally by default. The HTML report loads Chart.js from jsDelivr CDN. If you configure `config.json`'s `webhookUrl` (or `CC_WEBHOOK_URL`), every captured event is POSTed to that URL as JSON — this is opt-in and unset by default.

## Known Security Considerations

- **`CC_PROJECTS_DIR` / `CC_STORE_DIR`**: these environment variables control where the CLI scans for session logs and stores events. They are set by the same user running the CLI, so there is no privilege escalation, but as defense in depth the scan directory is resolved with `~` expansion and rejects `/etc`, `/sys`, `/proc` and `/dev` outright (#147).
- **`hook-capture` concurrency**: Claude Code can fire the `PreToolUse`/`PostToolUse` hooks from multiple processes in close succession. Appends use `fs.appendFile` (O_APPEND), which is atomic for the small, single-line writes this tool produces, so concurrent hook invocations do not corrupt `events.jsonl`. Destructive/rewriting operations (`clear`, `prune`, `doctor --fix-store`, `tag`) are user-invoked CLI commands rather than hook-fired, and are serialized within a single process; running two of them against the same store at the exact same instant from separate processes is not guarded by a cross-process lock (#161).
- **Trigger messages**: by default, the text of the user message that preceded a skill invocation is stored locally and may appear in the HTML report. Use `--redact` / `redactTriggerMessages` in `config.json`, or `--no-capture` on `scan`, if that content is sensitive.

## Out of Scope

- Vulnerabilities in Claude Code itself
- Issues requiring physical access to the user's machine
- Social engineering attacks
