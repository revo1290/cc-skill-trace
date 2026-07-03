import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/** Returned when no readable `package.json` can be located (#173). */
export const FALLBACK_VERSION = "0.0.0-unknown";

const PACKAGE_NAME = "cc-skill-trace";

/**
 * Resolve this package's version by walking up from `startDir` to the nearest
 * `package.json`.
 *
 * The previous implementation read `../../package.json` via a hardcoded
 * relative path, which (a) breaks if the compiled layout under `dist/` changes
 * or the code is bundled, and (b) throws at module load — crashing *every* CLI
 * command, not just `--version`, when the manifest can't be resolved (#173).
 *
 * This resolver is structure-independent and never throws: it prefers the
 * `package.json` whose `name` matches this package (so a parent/monorepo
 * manifest isn't picked up), falls back to the first manifest with a valid
 * version string, and finally to `FALLBACK_VERSION`.
 */
export function resolveVersion(startDir: string): string {
  let dir = startDir;
  const { root } = parse(dir);
  let firstValid: string | undefined;

  // Walk up to the filesystem root, inspecting a package.json at each level.
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (pkg && typeof pkg.version === "string") {
        // Exact package match wins immediately.
        if (pkg.name === PACKAGE_NAME) return pkg.version;
        // Otherwise remember the closest valid version as a fallback.
        if (firstValid === undefined) firstValid = pkg.version;
      }
    } catch {
      // No package.json here, or it was unreadable/malformed — keep walking up.
    }

    if (dir === root) break;
    dir = dirname(dir);
  }

  return firstValid ?? FALLBACK_VERSION;
}
