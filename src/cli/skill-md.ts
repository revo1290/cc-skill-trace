// Line-ending helpers for comparing / writing the bundled vs installed SKILL.md.
//
// On Windows with `git config core.autocrlf true`, a checked-out SKILL.md may use
// CRLF (`\r\n`) while the bundled copy uses LF (`\n`). A byte-exact comparison then
// reports the installed file as "stale" forever, so `install` overwrites it on every
// run even though the content is identical (#181).

/** Normalize CRLF / lone-CR line endings to LF for content comparison. */
export function normalizeSkillMd(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** True when installed and bundled SKILL.md differ ignoring line-ending style. */
export function skillMdChanged(installed: string, bundled: string): boolean {
  return normalizeSkillMd(installed) !== normalizeSkillMd(bundled);
}
