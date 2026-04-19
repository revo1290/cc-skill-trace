# Contributing to cc-skill-trace

Thank you for your interest in contributing!

## Getting started

```bash
git clone https://github.com/revo1290/cc-skill-trace.git
cd cc-skill-trace
npm install
npm run build
npm test
```

## Development workflow

```bash
npm run dev        # watch mode (recompiles on save)
npm run typecheck  # type-check without emitting
npm test           # run the test suite
```

The CLI can be tested locally with:
```bash
node dist/cli/index.js show
node dist/cli/index.js --help
```

## Submitting changes

1. **Fork** the repository and create a feature branch from `main`.
2. Make your changes and add tests for any new logic.
3. Run `npm test` and `npm run typecheck` — both must pass.
4. Open a pull request with a clear description of what changed and why.

## Code style

- TypeScript strict mode is enforced (`"strict": true` in tsconfig).
- No external runtime dependencies beyond `chalk` and `commander`.
- The hook (`hook-capture`) must **never** block Claude Code — catch all exceptions and always exit 0.
- Keep the event store format (`SkillInvocationEvent`) backwards-compatible.

## Reporting bugs

Use [GitHub Issues](https://github.com/revo1290/cc-skill-trace/issues).
For security issues, see [SECURITY.md](./SECURITY.md) instead.
