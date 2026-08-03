# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**cc-skill-trace** — A Skill invocation debugger and visualizer for Claude Code, Codex CLI, and GitHub Copilot CLI.  
An OSS tool that tracks which skills are invoked, when, and why, then visualizes the results in a browser-based report. Claude Code support is stable; Codex CLI and GitHub Copilot CLI support is best-effort (see `ProviderConfidence` in `src/core/providers/types.ts` and #v3-multi-provider).

## Commands

```bash
npm install           # Install dependencies
npm run build         # Compile TypeScript to dist/ (tsc) + copy SKILL.md to dist/skill/
npm run dev           # Build in watch mode
npm run typecheck     # Type check only (no compilation)
npm run lint          # biome lint
npm run format:check  # biome format check (npm run format to auto-fix)
npm test              # Run all tests (includes integration.test.ts which spawns CLI subprocesses)
npm run test:unit     # Unit tests only (excludes integration.test.ts)
node dist/cli/index.js <cmd>   # Run the CLI after building
node --import tsx/esm src/cli/index.ts <cmd>   # Run the CLI from src/ without building
```

## Architecture

```
src/
├── core/
│   ├── types.ts      # All type definitions (SessionLogEntry, SkillInvocationEvent, HookPayload, EVENT_SCHEMA_VERSION)
│   ├── parser.ts     # Parse ~/.claude/projects/**/*.jsonl to extract skill invocations
│   ├── store.ts      # Read/write events.jsonl, consistency checks, repair, deduplication
│   ├── filter.ts     # EventFilter (--since/--skill/--grep etc.) and date/duration parsers
│   ├── analyze.ts    # Auto-invocation diagnosis, period diffs, cost estimation, streak analysis
│   ├── config.ts     # Read/write ~/.cc-skill-trace/{config.json,state.json}, getStoreDir()
│   ├── utils.ts      # Small utility helpers like expandTilde
│   └── providers/    # Multi-provider CLI support (#v3-multi-provider)
│       ├── types.ts        # Provider interface, SkillDef, ProviderConfidence
│       ├── index.ts        # PROVIDERS registry, getProvider()/resolveProviderId()
│       ├── skill-md.ts     # SKILL.md frontmatter parser (shared by 3 providers, zero dependencies)
│       ├── claude-code.ts  # Wrapper around parser.ts (confidence: stable)
│       ├── codex.ts        # Parse ~/.codex/sessions/**/*.jsonl + write hooks.json (best-effort)
│       ├── copilot.ts      # Supports hook-capture only, scan not supported (best-effort)
│       └── scan.ts         # Generic extractAllInvocationsForProvider for non-Claude-Code providers
├── skill/
│   └── SKILL.md       # Claude Code Skill definition. Becomes the /skill-trace slash command
└── cli/
    ├── index.ts        # CLI entry point (commander). Thin wiring that calls each registerXCommand
    ├── context.ts      # VERSION resolution, lazy load + cache config
    ├── options.ts      # Shared filter option definitions (addFilterOptions etc.)
    ├── ui.ts           # Color control, confirmation prompts, browser launch, update check helpers
    ├── format.ts       # Terminal dashboard (box-drawing + chalk. renderDashboard is the core)
    ├── web-report.ts   # Standalone HTML report generation (Chart.js loaded from CDN)
    ├── atomic-write.ts # Atomic writes to settings.json (.tmp→rename, cleanup on failure)
    ├── hooks.ts        # Detect own hook entries in settings.json (command field exact match)
    ├── skill-md.ts     # Compare old/new SKILL.md (CRLF-agnostic)
    ├── follow.ts       # Guard against overlap in show --follow
    ├── duration.ts     # Simple duration parser for clear --older-than (separate from filter.ts)
    ├── version.ts      # Resolve version by traversing package.json (structure-agnostic)
    └── commands/
        ├── install.ts  # install / uninstall / status / doctor / init
        ├── scan.ts     # scan (--resume/--watch/--dry-run), scanAndMerge shared logic
        ├── show.ts     # show (default command), replay
        ├── stats.ts    # stats / list-skills / diagnose / check
        ├── export.ts   # export (json/csv/sql) / report / clear / prune / tag
        ├── capture.ts  # hook-capture (handle both Pre/PostToolUse here)
        └── completion.ts # completion (bash/zsh/fish)
```

### Data flow

1. `cc-skill-trace install` → Register PreToolUse + PostToolUse hooks in `~/.claude/settings.json` + copy `~/.claude/skills/skill-trace/SKILL.md`
2. During Claude Code session, Skill tool is invoked → PreToolUse hook → `hook-capture` subprocess runs and appends event
3. When Skill tool completes → PostToolUse hook → `hook-capture --post` appends outcome/durationMs to same event
4. `hook-capture` always returns `{}` (non-blocking). stdin read has timeout and size limits
5. `cc-skill-trace show` → Read events.jsonl and display **terminal dashboard**
6. `/skill-trace` (inside Claude Code) → Claude follows SKILL.md instructions and runs `cc-skill-trace show --scan --terse`, then explains the results
7. `cc-skill-trace report` → Read events.jsonl, generate HTML, open in browser
8. `cc-skill-trace scan` → Backfill by traversing `~/.claude/projects/**/*.jsonl`. Reconcile hook-originated events with `selectNewEvents` (session+skill+args+time window) to prevent double-registration. On a match, `enrichExistingEvents` backfills the existing event's `triggerMessage`/`source` via `updateEvent` (#223)

### Key design decisions

- Hooks **never block Claude Code** (swallow all exceptions, exit 0)
- `hook-capture` is implemented as a hidden subcommand in `src/cli/commands/capture.ts` (handle both Pre/Post in this one file)
- `show` is the default command — running `cc-skill-trace` alone displays the dashboard
- Terminal output uses box-drawing characters + ANSI colors for maximum readability (`format.ts:renderDashboard`). Auto-disabled on `NO_COLOR`/non-TTY
- HTML report is a zero-dependency standalone file (Chart.js from CDN, heatmap/per-branch graphs use custom CSS)
- Event store is JSONL. Schema version managed via `v` field (v1 implicit, v2 adds `recordedVia`/`tags`/`outcome`/`durationMs`, v3 adds `provider`. Missing `provider` always treated as `"claude-code"`)
- `readEvents` uses streaming reads + per-line filtering. Does not load entire file into memory
- Config split into `~/.cc-skill-trace/config.json` (user-editable) and `state.json` (internal state, last scan, etc.)
- Switch event store location via `CC_STORE_DIR` / `--store`
- Diagnostic logging to stderr via `CC_DEBUG=1` or `--verbose`
- Adjust scan concurrency with `CC_SCAN_CONCURRENCY` environment variable (default: 8)
- Override scan directory with `CC_PROJECTS_DIR` environment variable (leading `~/` expands to home. `validateProjectsDir` rejects paths under `/etc`, `/sys`, `/proc`, `/dev`, see #147)
- SKILL.md priority: `dist/skill/SKILL.md` (copied by `scripts/copy-skill.mjs` at build time), fall back to `src/skill/SKILL.md` (included via `files`)
- `install`/`uninstall` identify hooks in settings.json by exact match of `hooks[].command` field (`isCcSkillTraceHook`). Never accidentally touch other tools' hooks
- Override `~/.codex` and `~/.copilot` locations via `CC_CODEX_HOME` / `CC_COPILOT_HOME` environment variables (same pattern as `CC_PROJECTS_DIR`). `providers/codex.ts`/`copilot.ts` read these as **call-time functions** (`codexHome()`/`copilotHome()`) not module-level constants — because if they were constants, tests that swap `process.env` would not be properly sandboxed

### Multi-provider skill invocation detection (#v3-multi-provider)

- **Claude Code**: Has a dedicated `Skill` tool_use, so detection is certain (stable)
- **Codex CLI**: No dedicated skill tool call exists. After investigating real session logs, we found that models use skills by reading the installed skill's `SKILL.md` absolute path via normal shell execution (`exec_command`) presented in the skill list (e.g. `sed -n '1,220p' /path/to/SKILL.md`). We detect by checking whether the argument string of `function_call`/`custom_tool_call` contains the installed skill's `SKILL.md` path as a substring (best-effort, but scan path verified against real data)
- **GitHub Copilot CLI**: No local runtime, so inference is documentation-only. Hook payload uses camelCase (`sessionId`/`toolName`/`toolArgs`/`toolResult`). We apply the same path substring-match logic to `toolArgs` after JSON.stringify. Session log format is proprietary, so `scan` is not supported — only `hook-capture`
- The above detection logic exists in both `src/core/providers/{codex,copilot}.ts` (for scan/list-skills) and `src/cli/commands/capture.ts` (for hook-capture, e.g. `parseCodexPre`/`parseCopilotPre`). Payload shapes differ, but the core logic ("substring match on installed skill absolute path") is shared

### Concurrency safety design (#161)

- `appendEvent` uses only `fs.appendFile` (O_APPEND) — a pure append operation. On POSIX, a single write smaller than PIPE_BUF is atomic even across multiple processes, and a single-event JSON line is far smaller than that. **Multiple `hook-capture` processes launching simultaneously cannot corrupt or overwrite lines.** The "hook-capture cross-process concurrency" test in `src/cli/integration.test.ts` verifies this by spawning real processes in parallel
- `pruneEvents`/`clearEvents`/`updateEvent`/`repairStore` are read-modify-write (load all, rewrite), guaranteeing serialization only **within a process** via `enqueueWrite` per-directory promise chain. These are explicitly-invoked CLI commands; the risk of simultaneous multi-process execution against the same store is judged low. Cross-process file locking is intentionally not implemented — simultaneous execution is permitted to lose one side's changes (accepted tradeoff)

### hook-capture and triggerMessage limitations

Events recorded via real-time hooks (`hook-capture`) do not include `triggerMessage` at the time they're captured — the PreToolUse hook payload never includes the immediately preceding user message (a permanent limitation).

However, running `cc-skill-trace scan` re-discovers the same invocation from the session log, and `store.ts`'s `enrichExistingEvents` (#223) backfills the missing `triggerMessage` **onto the existing hook-captured event in place** (never as a new, duplicate row). `source` is similarly upgraded to `"user"` when the hook side is `"claude"` (unknown/default) and scan finds stronger evidence (e.g. Codex's explicit `$SkillName` mention, or Claude Code's slash-command detection). Only values are ever added — an existing value is never overwritten or downgraded (`"user"` → `"claude"`). In short: `hook-capture` alone permanently lacks `triggerMessage`, but running `scan` afterward backfills it.

### Where to add tests

New core logic goes in the corresponding `*.test.ts` file (example: `core/filter.ts` → `core/filter.test.ts`). End-to-end CLI behavior (real subprocess spawning, sandboxed `HOME`/`CC_STORE_DIR`/`CC_PROJECTS_DIR`) is consolidated in `cli/integration.test.ts`.
