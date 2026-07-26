import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toCsv, toSql } from "./export.js";
import type { SkillInvocationEvent } from "../../core/types.js";

function makeEvent(overrides: Partial<SkillInvocationEvent> = {}): SkillInvocationEvent {
  return {
    id: "test-id",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "session-1",
    skillName: "test-skill",
    source: "claude",
    ...overrides,
  };
}

describe("toCsv (#79 RFC 4180, #193 --no-bom)", () => {
  it("prefixes a UTF-8 BOM by default", () => {
    const out = toCsv([makeEvent()], true);
    assert.equal(out.charCodeAt(0), 0xfeff);
  });

  it("omits the BOM when bom=false", () => {
    const out = toCsv([makeEvent()], false);
    assert.notEqual(out.charCodeAt(0), 0xfeff);
    assert.ok(out.startsWith('"id"'));
  });

  it("quotes fields containing commas, quotes or newlines, doubling embedded quotes", () => {
    const out = toCsv([makeEvent({ triggerMessage: 'has "quotes", a comma, and\na newline' })], false);
    assert.ok(out.includes('"has ""quotes"", a comma, and\na newline"'));
  });

  it("uses CRLF record separators per RFC 4180", () => {
    const out = toCsv([makeEvent(), makeEvent({ id: "second" })], false);
    assert.ok(out.includes("\r\n"));
    assert.ok(!out.replace(/\r\n/g, "").includes("\n"), "no bare LF should remain outside of CRLF pairs");
  });

  it("joins array fields (tags) with semicolons", () => {
    const out = toCsv([makeEvent({ tags: ["a", "b"] })], false);
    assert.ok(out.includes("a;b"));
  });

  it("renders null/undefined fields as empty", () => {
    const out = toCsv([makeEvent({ skillArgs: undefined })], false);
    const rows = out.split("\r\n");
    assert.equal(rows.length, 3); // header + 1 data row + trailing empty
  });
});

describe("toSql (#97)", () => {
  it("produces a CREATE TABLE statement and one INSERT per event", () => {
    const out = toSql([makeEvent({ id: "a" }), makeEvent({ id: "b" })]);
    assert.ok(out.includes("CREATE TABLE IF NOT EXISTS skill_events"));
    assert.ok((out.match(/INSERT OR REPLACE INTO skill_events/g) ?? []).length === 2);
  });

  it("escapes single quotes by doubling them", () => {
    const out = toSql([makeEvent({ triggerMessage: "it's a test" })]);
    assert.ok(out.includes("it''s a test"));
  });

  it("renders null for missing optional fields", () => {
    const out = toSql([makeEvent({ skillArgs: undefined })]);
    assert.ok(/VALUES \('test-id', '2026-01-01T00:00:00\.000Z', 'session-1', 'test-skill', NULL,/.test(out));
  });

  it("wraps inserts in a transaction", () => {
    const out = toSql([makeEvent()]);
    assert.ok(out.includes("BEGIN TRANSACTION;"));
    assert.ok(out.trim().endsWith("COMMIT;"));
  });
});
