# Support

## Getting help

| Type | Where |
|---|---|
| Bug reports | [GitHub Issues](https://github.com/revo1290/cc-skill-trace/issues) — use the **Bug Report** template |
| Feature requests | [GitHub Issues](https://github.com/revo1290/cc-skill-trace/issues) — use the **Feature Request** template |
| Questions & discussion | [GitHub Discussions](https://github.com/revo1290/cc-skill-trace/discussions) |
| Security vulnerabilities | See [SECURITY.md](./SECURITY.md) — do **not** file a public issue |

## Before opening an issue

1. Check the [README](./README.md) — especially the CLI reference and "How it works" sections.
2. Search [existing issues](https://github.com/revo1290/cc-skill-trace/issues) to avoid duplicates.
3. Run `cc-skill-trace --version` and `node --version` so you have that info ready.

## Claude Code plugin questions

If `/skill-trace` is not appearing in Claude Code after `cc-skill-trace install`:

- Confirm the hook was registered: check `~/.claude/settings.json` for a `PreToolUse` entry with matcher `"Skill"`.
- Restart Claude Code after installing.
- Re-run `cc-skill-trace install` if the entry is missing.
