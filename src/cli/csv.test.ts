import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCsv, CSV_HEADERS } from "./csv.js";
import type { SkillInvocationEvent } from "../core/types.js";

const BOM = "\uFEFF";

function ev(overrides: Partial<SkillInvocationEvent> = {}): SkillInvocationEvent {
  return {
    id: "evt-1",
    timestamp: "2026-01-03T00:00:00.000Z",
    sessionId: "sess-A",
    skillName: "commit",
    source: "claude",
    ...overrides,
  };
}

describe("toCsv", () => {
  it("prepends a UTF-8 BOM by default", () => {
    const out = toCsv([ev()]);
    assert.equal(out[0], BOM);
    // The header row must start with the BOM immediately followed by the first column.
    assert.ok(out.startsWith(`${BOM}"id",`));
  });

  it("omits the BOM when bom: false (#193 --no-bom)", () => {
    const out = toCsv([ev()], { bom: false });
    assert.equal(out.startsWith(BOM), false);
    assert.ok(out.startsWith(`"id",`));
    // First byte is the ASCII quote, so Unix tooling sees a clean "id" column.
    assert.equal(out.charCodeAt(0), '"'.charCodeAt(0));
  });

  it("emits the full header row in order", () => {
    const out = toCsv([], { bom: false });
    const header = out.split("\n")[0];
    assert.equal(header, CSV_HEADERS.map((h) => `"${h}"`).join(","));
  });

  it("renders one row per event with fields in header order", () => {
    const out = toCsv(
      [ev({ id: "a", skillName: "review", injectedTokens: 42 })],
      { bom: false },
    );
    const rows = out.split("\n");
    assert.equal(rows.length, 2);
    assert.equal(rows[1], "a,2026-01-03T00:00:00.000Z,sess-A,review,,claude,,42,,");
  });

  it("quotes and escapes fields containing commas, quotes, or newlines", () => {
    const out = toCsv(
      [ev({ triggerMessage: 'hi, "there"\nbye' })],
      { bom: false },
    );
    // The trigger message column is index 6; it must be wrapped in quotes with
    // internal double-quotes doubled, and the embedded newline preserved verbatim.
    assert.ok(out.includes('"hi, ""there""\nbye"'));
  });

  it("renders undefined optional fields as empty strings", () => {
    const out = toCsv([ev()], { bom: false });
    const row = out.split("\n")[1];
    // skillArgs, triggerMessage, injectedTokens, cwd, gitBranch are all unset.
    assert.equal(row, "evt-1,2026-01-03T00:00:00.000Z,sess-A,commit,,claude,,,,");
  });
});
