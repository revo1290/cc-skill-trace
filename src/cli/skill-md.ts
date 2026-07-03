// Pure decision logic for whether the installed SKILL.md is out of date (#190).
//
// Reading the files is IO and stays in the caller; this module only interprets
// the read results. Keeping it pure lets it be unit-tested and, crucially, keeps
// the three cases distinct so an unreadable *bundled* file is no longer silently
// swallowed as "up to date":
//
//   - bundled unreadable   → likely a broken build; caller should surface it,
//                            but this is not a stale install (stale = false)
//   - installed unreadable → not installed yet; nothing to update (stale = false)
//   - both readable        → stale iff the contents differ

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
  return { stale: bundled.content !== installed.content, bundledMissing: false };
}
