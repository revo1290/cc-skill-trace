import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expand a leading `~` in a path to the user's home directory.
 *
 * Node's fs APIs do not interpret `~` — the shell normally expands it before
 * the value reaches the process, but values coming from environment variables
 * (e.g. `CC_PROJECTS_DIR=~/path`) or config files are passed through verbatim,
 * which leads to `ENOENT` for `~/...` paths. This helper handles:
 *
 *   - `~`            → home directory
 *   - `~/rest`       → join(home, "rest")   (POSIX)
 *   - `~\rest`       → join(home, "rest")   (Windows)
 *
 * A bare `~user` form (another user's home) is intentionally left untouched
 * since it cannot be resolved portably.
 */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return join(homedir(), p.slice(2));
  }
  return p;
}
