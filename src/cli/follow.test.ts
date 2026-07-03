import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { skipWhileRunning } from "./follow.js";

describe("skipWhileRunning", () => {
  it("skips calls that arrive while a previous call is still in-flight", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const guarded = skipWhileRunning(async () => {
      calls++;
      await gate; // stay in-flight until released
    });

    const first = guarded(); // starts running, blocks on `gate`
    await guarded(); // fires mid-run → must be skipped
    await guarded(); // still mid-run → must be skipped
    assert.equal(calls, 1, "concurrent ticks should be dropped");

    release();
    await first;

    await guarded(); // previous call finished → runs again
    assert.equal(calls, 2);
  });

  it("resets the guard even when the wrapped function throws", async () => {
    let calls = 0;
    const guarded = skipWhileRunning(async () => {
      calls++;
      throw new Error("boom");
    });

    await assert.rejects(guarded(), /boom/);
    await assert.rejects(guarded(), /boom/);
    assert.equal(calls, 2, "guard must reset after a rejection");
  });

  it("allows sequential (non-overlapping) calls to run every time", async () => {
    let calls = 0;
    const guarded = skipWhileRunning(async () => {
      calls++;
    });

    await guarded();
    await guarded();
    await guarded();
    assert.equal(calls, 3);
  });
});
