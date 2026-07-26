import { writeFile, rename, copyFile as fsCopyFile, rm, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomically write JSON to `path`:
 *  1. Create the parent directory if it doesn't exist yet (e.g. a fresh
 *     machine where `~/.claude/` has never been created)
 *  2. Back up the current file as `<path>.bak` (best-effort)
 *  3. Write new content to `<path>.tmp`
 *  4. Rename tmp → path  (atomic on POSIX; best-effort on Windows)
 *
 * If the rename fails (disk full, cross-device move, permission error, …) the
 * leftover `<path>.tmp` is removed before the error is re-thrown, so stale tmp
 * files do not accumulate on the filesystem. (#184)
 */
export async function writeSettingsAtomic(path: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  const tmp = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  // Best-effort backup — don't fail if the original doesn't exist yet
  try {
    await fsCopyFile(path, `${path}.bak`);
  } catch {
    /* no original yet */
  }
  await writeFile(tmp, json, "utf-8");
  try {
    await rename(tmp, path);
  } catch (err) {
    // Clean up the leftover tmp file before re-throwing (#184)
    try {
      await rm(tmp, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }
}
