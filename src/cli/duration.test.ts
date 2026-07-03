import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDuration } from "./duration.js";

/** Elapsed milliseconds between the returned cutoff and "now", within tolerance. */
function elapsedMs(cutoff: Date): number {
  return Date.now() - cutoff.getTime();
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Generous tolerance so the test is not flaky on slow CI.
const TOL = 5 * MIN;

describe("parseDuration", () => {
  it("supports minutes (min)", () => {
    assert.ok(Math.abs(elapsedMs(parseDuration("30min")) - 30 * MIN) < TOL);
    assert.ok(Math.abs(elapsedMs(parseDuration("90min")) - 90 * MIN) < TOL);
  });

  it("supports hours (h)", () => {
    assert.ok(Math.abs(elapsedMs(parseDuration("12h")) - 12 * HOUR) < TOL);
  });

  it("supports days (d)", () => {
    assert.ok(Math.abs(elapsedMs(parseDuration("30d")) - 30 * DAY) < TOL);
  });

  it("supports weeks (w)", () => {
    assert.ok(Math.abs(elapsedMs(parseDuration("4w")) - 4 * WEEK) < TOL);
  });

  it("is case-insensitive", () => {
    assert.ok(Math.abs(elapsedMs(parseDuration("30MIN")) - 30 * MIN) < TOL);
    assert.ok(Math.abs(elapsedMs(parseDuration("12H")) - 12 * HOUR) < TOL);
  });
});
