// Helpers for comparing the bundled vs installed SKILL.md.
//
// Two concerns live here:
//
//  1. Line endings (#181). On Windows with `git config core.autocrlf true`, a
//     checked-out SKILL.md may use CRLF (`\r\n`) while the bundled copy uses LF
//     (`\n`). A byte-exact comparison then reports the installed file as "stale"
//     forever, so `install` overwrites it on every run even though the content
//     is identical. All content comparisons normalize line endings first.
//
//  2. Distinguishing read failures (#190). Reading the files is IO and stays in
//     the caller; `computeSkillMdStale` only interprets the read results, which
//     keeps the three cases distinct so an unreadable *bundled* file is no
//     longer silently swallowed as "up to date":
//
//       - bundled unreadable   → likely a broken build; caller should surface
//                                it, but this is not a stale install (stale = false)
//       - installed unreadable → not installed yet; nothing to update (stale = false)
//       - both readable        → stale iff the contents differ (line-ending agnostic)

/** Normalize CRLF / lone-CR line endings to LF for content comparison. */
export function normalizeSkillMd(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** True when installed and bundled SKILL.md differ ignoring line-ending style. */
export function skillMdChanged(installed: string, bundled: string): boolean {
  return normalizeSkillMd(installed) !== normalizeSkillMd(bundled);
}

export type ReadResult = { ok: true; content: string } | { ok: false };

export interface SkillMdStatus {
  stale: boolean;
  /** True when the bundled SKILL.md could not be read (likely a broken build). */
  bundledMissing: boolean;
}

export function computeSkillMdStale(bundled: ReadResult, installed: ReadResult): SkillMdStatus {
  if (!bundled.ok) {
    return { stale: false, bundledMissing: true };
  }
  if (!installed.ok) {
    return { stale: false, bundledMissing: false };
  }
  // Line-ending agnostic so a CRLF checkout is not reported stale forever (#181).
  return { stale: skillMdChanged(installed.content, bundled.content), bundledMissing: false };
}
