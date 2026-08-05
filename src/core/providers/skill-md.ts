/**
 * Parse the YAML frontmatter of a SKILL.md file for `name`/`description`.
 * All three supported agent CLIs (Claude Code, Codex CLI, GitHub Copilot CLI)
 * share this same `SKILL.md` convention (a `---`-delimited frontmatter block
 * with `name:` and `description:`), so this parser is intentionally
 * provider-agnostic. A hand-rolled parser is used instead of a YAML library
 * to keep the dependency count at zero — the frontmatter here is always flat
 * key/value pairs, never nested structures, so this is sufficient.
 */
export function parseSkillFrontmatter(
  content: string
): { name: string; description?: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;
  // biome-ignore lint/style/noNonNullAssertion: group 1 is mandatory in the pattern above, so it's always captured once `match` itself is non-null.
  const frontmatter = match[1]!;

  const nameMatch = /^name:\s*(.+)$/m.exec(frontmatter);
  if (!nameMatch) return null;
  // biome-ignore lint/style/noNonNullAssertion: group 1 (`.+`) is mandatory, so it's always captured once `nameMatch` itself is non-null.
  const name = nameMatch[1]!.trim().replace(/^["']|["']$/g, "");

  // description may be a single line or a YAML block scalar (`>` / `|`),
  // in which case the following indented lines are its continuation.
  const descMatch = /^description:\s*(.*)$/m.exec(frontmatter);
  let description: string | undefined;
  if (descMatch) {
    // biome-ignore lint/style/noNonNullAssertion: group 1 is mandatory (can match an empty string, but always participates), so it's always captured here.
    const first = descMatch[1]!.trim();
    if (first === ">" || first === "|" || first === ">-" || first === "|-") {
      const afterIdx = frontmatter.indexOf(descMatch[0]) + descMatch[0].length;
      const rest = frontmatter.slice(afterIdx).split("\n");
      const lines: string[] = [];
      for (const line of rest) {
        if (line.trim() === "" || /^\s/.test(line)) {
          if (line.trim() !== "") lines.push(line.trim());
          continue;
        }
        break; // dedented — frontmatter continues with the next key
      }
      description = lines.join(" ").trim() || undefined;
    } else {
      description = first.replace(/^["']|["']$/g, "") || undefined;
    }
  }

  return { name, description };
}
