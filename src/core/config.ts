import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Persistent user configuration, stored at `~/.cc-skill-trace/config.json` (#131).
 *
 * Every field is optional; missing fields fall back to built-in defaults.
 * Environment variables always take precedence over config values.
 */
export interface TraceConfig {
  /** Map of raw skill name → display alias, applied in all renderers (#143). */
  aliases?: Record<string, string>;
  /** Auto-delete events older than N days on dashboard commands (#146). 0/absent = disabled. */
  autoPruneDays?: number;
  /** POST every captured event to this URL as JSON (#139). */
  webhookUrl?: string;
  /** Webhook request timeout in milliseconds (default 1500) (#139). */
  webhookTimeoutMs?: number;
  /** When false, `scan` omits triggerMessage from stored events (#74). */
  captureTriggerMessages?: boolean;
  /** When true, HTML reports mask trigger messages by default (#108). */
  redactTriggerMessages?: boolean;
  /** Max stored length of triggerMessage in characters (default 300) (#120). */
  triggerMessageMaxLen?: number;
  /** Set false to disable the daily npm update check (#81). */
  updateCheck?: boolean;
  /** Refresh interval for `show --follow` in milliseconds (default 2000) (#87). */
  followIntervalMs?: number;
  /** Terminal render width cap in columns (default 100) (#195). */
  maxWidth?: number;
}

/**
 * Internal state (not user-edited), stored at `~/.cc-skill-trace/state.json`.
 * Used for scan resume (#165), the update-check cache (#81) and auto-prune (#146).
 */
export interface TraceState {
  /** Epoch ms of the newest session-file mtime processed by the last scan (#165). */
  lastScanMtimeMs?: number;
  /** Epoch ms of the last npm registry version check (#81). */
  lastUpdateCheckAt?: number;
  /** Latest version seen on the npm registry (#81). */
  latestKnownVersion?: string;
  /** Epoch ms of the last automatic prune run (#146). */
  lastAutoPruneAt?: number;
}

export const CONFIG_FILE_NAME = "config.json";
export const STATE_FILE_NAME = "state.json";

/** Resolve the store directory: `--store` sets CC_STORE_DIR; else `~/.cc-skill-trace` (#95). */
export function getStoreDir(): string {
  return process.env.CC_STORE_DIR ?? join(homedir(), ".cc-skill-trace");
}

function numFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf-8"));
    if (parsed && typeof parsed === "object") return parsed as T;
  } catch {
    // missing or malformed → fall back to defaults
  }
  return undefined;
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  await rename(tmp, path);
}

/**
 * Load config.json from the store dir, merged with defaults and env overrides (#131).
 * Never throws — a missing or corrupt file yields the defaults.
 */
export async function loadConfig(
  dir = getStoreDir()
): Promise<
  Required<
    Pick<
      TraceConfig,
      | "captureTriggerMessages"
      | "redactTriggerMessages"
      | "triggerMessageMaxLen"
      | "updateCheck"
      | "followIntervalMs"
      | "maxWidth"
      | "webhookTimeoutMs"
      | "autoPruneDays"
    >
  > &
    TraceConfig
> {
  const file = (await readJsonFile<TraceConfig>(join(dir, CONFIG_FILE_NAME))) ?? {};
  return {
    aliases: file.aliases,
    webhookUrl: process.env.CC_WEBHOOK_URL ?? file.webhookUrl,
    webhookTimeoutMs: file.webhookTimeoutMs ?? 1500,
    autoPruneDays: file.autoPruneDays ?? 0,
    captureTriggerMessages: file.captureTriggerMessages ?? true,
    redactTriggerMessages: file.redactTriggerMessages ?? false,
    triggerMessageMaxLen: numFromEnv("CC_TRIGGER_MAX_LEN") ?? file.triggerMessageMaxLen ?? 300,
    updateCheck: process.env.CC_NO_UPDATE_CHECK === "1" ? false : (file.updateCheck ?? true),
    followIntervalMs: numFromEnv("CC_FOLLOW_INTERVAL_MS") ?? file.followIntervalMs ?? 2000,
    maxWidth: numFromEnv("CC_MAX_WIDTH") ?? file.maxWidth ?? 100,
  };
}

/** Persist (a subset of) config.json, preserving unknown keys already in the file. */
export async function saveConfig(patch: TraceConfig, dir = getStoreDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, CONFIG_FILE_NAME);
  const current = (await readJsonFile<Record<string, unknown>>(path)) ?? {};
  await writeJsonAtomic(path, { ...current, ...patch });
}

/** Load state.json (never throws; missing file yields `{}`). */
export async function loadState(dir = getStoreDir()): Promise<TraceState> {
  return (await readJsonFile<TraceState>(join(dir, STATE_FILE_NAME))) ?? {};
}

/** Merge a patch into state.json. */
export async function saveState(patch: TraceState, dir = getStoreDir()): Promise<void> {
  await mkdir(dir, { recursive: true });
  const current = await loadState(dir);
  await writeJsonAtomic(join(dir, STATE_FILE_NAME), { ...current, ...patch });
}
