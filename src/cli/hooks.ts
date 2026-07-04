// Detection of cc-skill-trace's own PreToolUse hook entry inside a
// Claude Code settings.json. Kept in its own module so it can be unit-tested
// without importing the CLI entrypoint (which runs `program.parse()` on load).

/** The command string cc-skill-trace registers as its PreToolUse hook. */
export const CC_HOOK_COMMAND = "cc-skill-trace hook-capture";

/**
 * Detect whether a PreToolUse hook entry is the cc-skill-trace capture hook.
 *
 * We inspect the nested `hooks[].command` fields directly instead of doing a
 * substring search over the whole serialized entry. A serialized-object search
 * (`JSON.stringify(h).includes("cc-skill-trace")`) matches any hook that merely
 * mentions the string anywhere — e.g. in an unrelated hook's `description` —
 * causing `install` to skip registration and `uninstall` to delete the wrong
 * hook. Matching the command field avoids both. (#187)
 */
export function isCcSkillTraceHook(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hk) => {
    if (!hk || typeof hk !== "object") return false;
    const command = (hk as { command?: unknown }).command;
    return typeof command === "string" && command.includes(CC_HOOK_COMMAND);
  });
}
