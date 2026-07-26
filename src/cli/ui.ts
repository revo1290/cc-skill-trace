import { execFileSync, execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { release } from "node:os";
import { createInterface } from "node:readline";
import chalk from "chalk";
import { loadState, saveState } from "../core/config.js";
import type { TraceConfig } from "../core/config.js";
import { pruneEvents } from "../core/store.js";

// ─── Color / TTY handling (#69, #179) ────────────────────────────────────────

/**
 * Disable ANSI colors when stdout is not a TTY (pipes, CI) or when the
 * NO_COLOR / CC_NO_COLOR conventions request it. FORCE_COLOR wins (chalk).
 */
export function setupColors(): void {
  if (process.env.FORCE_COLOR) return; // explicit override, chalk handles levels
  if (process.env.NO_COLOR != null || process.env.CC_NO_COLOR != null || !process.stdout.isTTY) {
    chalk.level = 0;
  }
}

/** Strip ANSI escape sequences (used by show --output, #142). */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars by definition
  return s.replace(/\x1B\[[0-9;]*m/g, "");
}

// ─── Verbose logging (#107) ──────────────────────────────────────────────────

let verboseEnabled = false;

/** Enable --verbose diagnostics for this process (#107). */
export function setVerbose(on: boolean): void {
  verboseEnabled = on || process.env.CC_DEBUG === "1";
}

/** Write a diagnostic line to stderr when --verbose / CC_DEBUG=1 is active. */
export function vlog(msg: string): void {
  if (verboseEnabled) process.stderr.write(chalk.gray(`[cc-skill-trace] ${msg}\n`));
}

/** Print an error message and exit 1. */
export function fail(msg: string): never {
  console.error(chalk.red(`✗  ${msg}`));
  process.exit(1);
}

// ─── Confirmation prompts (#68, #137) ────────────────────────────────────────

/**
 * Ask a yes/no question on the terminal.
 * - `force` (from --force / --yes) skips the prompt and returns true.
 * - In non-interactive contexts (no TTY) the answer is false — callers should
 *   tell users to pass --force in scripts.
 */
export async function confirm(question: string, force = false): Promise<boolean> {
  if (force) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((res) => {
    rl.question(`${chalk.yellow("?")} ${question} ${chalk.gray("[y/N]")} `, res);
  });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// ─── Browser opening (#92 WSL support) ───────────────────────────────────────

/** True when running inside Windows Subsystem for Linux. */
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (/microsoft/i.test(release())) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf-8"));
  } catch {
    return false;
  }
}

/**
 * Open a file or URL in the platform's default browser.
 * Handles macOS, Windows, WSL (#92) and Linux. Returns false on failure.
 */
export function openInBrowser(target: string): boolean {
  const attempts: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["open", [target]]]
      : process.platform === "win32"
        ? [["cmd", ["/c", "start", "", target]]]
        : isWsl()
          ? [
              ["wslview", [target]],
              ["powershell.exe", ["-NoProfile", "Start-Process", target]],
              ["xdg-open", [target]],
            ]
          : [["xdg-open", [target]]];
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { stdio: "ignore" });
      return true;
    } catch {
      // try the next launcher
    }
  }
  return false;
}

// ─── Environment checks (#71) ────────────────────────────────────────────────

/** Best-effort check whether a Claude Code process is currently running (#71). */
export function isClaudeCodeRunning(): boolean {
  try {
    if (process.platform === "win32") return false; // not worth a tasklist parse
    const out = execFileSync("pgrep", ["-x", "claude"], { stdio: ["ignore", "pipe", "ignore"] });
    return out.toString().trim().length > 0;
  } catch {
    return false;
  }
}

// ─── Update notification (#81) ───────────────────────────────────────────────

function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(".")
      .map((p) => parseInt(p, 10) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return false;
}

/**
 * Daily-cached npm registry check (#81). Never throws, never takes more than
 * ~1.5s, and stays silent on any failure. Returns the newer version if one
 * exists, so callers can print a one-line hint.
 */
export async function checkForUpdate(
  currentVersion: string,
  config: Pick<TraceConfig, "updateCheck">,
  dir?: string
): Promise<string | undefined> {
  if (config.updateCheck === false) return undefined;
  try {
    const state = await loadState(dir);
    const DAY = 24 * 60 * 60 * 1000;
    let latest = state.latestKnownVersion;
    if (!state.lastUpdateCheckAt || Date.now() - state.lastUpdateCheckAt > DAY) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      try {
        const res = await fetch("https://registry.npmjs.org/cc-skill-trace/latest", {
          signal: ctrl.signal,
          headers: { accept: "application/json" },
        });
        if (res.ok) {
          const body = (await res.json()) as { version?: string };
          if (typeof body.version === "string") latest = body.version;
        }
      } finally {
        clearTimeout(timer);
      }
      await saveState({ lastUpdateCheckAt: Date.now(), latestKnownVersion: latest }, dir);
    }
    if (latest && isNewerVersion(latest, currentVersion)) return latest;
  } catch {
    // offline or registry hiccup — stay silent
  }
  return undefined;
}

/** Render the one-line update hint (#81). */
export function updateHint(latest: string, current: string): string {
  return chalk.gray(
    `  ↑ Update available: ${current} → ${chalk.white(latest)}  (npm install -g cc-skill-trace)`
  );
}

// ─── Auto-prune (#146) ───────────────────────────────────────────────────────

/**
 * Delete events older than `config.autoPruneDays` at most once per day (#146).
 * Called from dashboard-style commands; silent unless something was pruned.
 */
export async function maybeAutoPrune(
  config: Pick<TraceConfig, "autoPruneDays">,
  dir?: string
): Promise<number> {
  const days = config.autoPruneDays ?? 0;
  if (!days || days <= 0) return 0;
  const state = await loadState(dir);
  const DAY = 24 * 60 * 60 * 1000;
  if (state.lastAutoPruneAt && Date.now() - state.lastAutoPruneAt < DAY) return 0;
  const cutoff = new Date(Date.now() - days * DAY).toISOString();
  const { removed } = await pruneEvents(cutoff, dir);
  await saveState({ lastAutoPruneAt: Date.now() }, dir);
  if (removed > 0) vlog(`auto-pruned ${removed} events older than ${days}d`);
  return removed;
}

// ─── Webhook delivery (#139) ─────────────────────────────────────────────────

/**
 * POST a JSON payload to the configured webhook (#139).
 * Bounded by `timeoutMs`; all failures are swallowed (the hook must never
 * block or break Claude Code).
 */
export async function postWebhook(url: string, payload: unknown, timeoutMs = 1500): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch {
    // never let webhook failures surface
  } finally {
    clearTimeout(timer);
  }
}

// ─── Misc helpers ────────────────────────────────────────────────────────────

/** Run a command detached-ish and ignore all failures (fire-and-forget). */
export function tryExec(cmd: string, args: string[]): void {
  try {
    execFile(cmd, args, () => {});
  } catch {
    // ignore
  }
}
