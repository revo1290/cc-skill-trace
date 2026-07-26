import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../core/config.js";
import { resolveVersion } from "./version.js";

/**
 * Package version, resolved once at load time.
 *
 * Walks up from this file's directory to find the nearest package.json named
 * "cc-skill-trace" — structure-independent and never throws, so a relocated
 * dist/ layout or bundling can't crash every CLI command (#173).
 */
export const VERSION = resolveVersion(dirname(fileURLToPath(import.meta.url)));

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

let cached: LoadedConfig | undefined;

/**
 * Lazily load (and cache) the merged config for this process.
 * Must be called after global options (--store) have been applied to the env.
 */
export async function getConfig(): Promise<LoadedConfig> {
  if (!cached) cached = await loadConfig();
  return cached;
}

/** Test hook: forget the cached config. */
export function resetConfigCache(): void {
  cached = undefined;
}
