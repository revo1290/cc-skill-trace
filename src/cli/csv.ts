import type { SkillInvocationEvent } from "../core/types.js";

/** Columns emitted by `export --format csv`, in order. */
export const CSV_HEADERS: (keyof SkillInvocationEvent)[] = [
  "id",
  "timestamp",
  "sessionId",
  "skillName",
  "skillArgs",
  "source",
  "triggerMessage",
  "injectedTokens",
  "cwd",
  "gitBranch",
];

export interface ToCsvOptions {
  /**
   * Prepend a UTF-8 BOM so Excel opens non-ASCII text without garbling (#193).
   * Set to `false` (via `--no-bom`) for Unix tooling (csvkit, pandas, awk, …)
   * that treats the BOM bytes as part of the first field name. Default: `true`.
   */
  bom?: boolean;
}

/** UTF-8 byte order mark (U+FEFF). */
const BOM = "\uFEFF";

/** Escape a single CSV field per RFC 4180 (quote if it contains , " or newline). */
function escapeField(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

/** Serialize events to a CSV string, optionally prefixed with a UTF-8 BOM. */
export function toCsv(events: SkillInvocationEvent[], options: ToCsvOptions = {}): string {
  const bom = options.bom ?? true;
  const body =
    CSV_HEADERS.map((h) => `"${h}"`).join(",") +
    "\n" +
    events.map((e) => CSV_HEADERS.map((h) => escapeField(e[h])).join(",")).join("\n");
  return (bom ? BOM : "") + body;
}
