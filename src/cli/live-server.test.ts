import assert from "node:assert/strict";
import { request } from "node:http";
import { afterEach, describe, it } from "node:test";
import type { SkillInvocationEvent } from "../core/types.js";
import {
  DEFAULT_LIVE_POLL_MS,
  type LiveReportServer,
  isAllowedHost,
  startLiveReportServer,
} from "./live-server.js";

function makeEvent(overrides: Partial<SkillInvocationEvent> = {}): SkillInvocationEvent {
  return {
    id: "e1",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: "session-1",
    skillName: "pdf",
    source: "claude",
    ...overrides,
  };
}

/** `fetch` silently drops a caller-supplied Host header (it is a forbidden
 *  header name), so the rebinding guard has to be exercised over raw http. */
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { Host: host } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

let running: LiveReportServer | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
});

describe("isAllowedHost (#228 — DNS rebinding guard)", () => {
  it("accepts loopback hosts on the bound port", () => {
    assert.ok(isAllowedHost("127.0.0.1:4321", 4321, "127.0.0.1"));
    assert.ok(isAllowedHost("localhost:4321", 4321, "127.0.0.1"));
    assert.ok(isAllowedHost("[::1]:4321", 4321, "127.0.0.1"));
    assert.ok(isAllowedHost("localhost", 4321, "127.0.0.1"));
  });

  it("rejects a rebound external hostname", () => {
    assert.ok(!isAllowedHost("evil.example.com:4321", 4321, "127.0.0.1"));
    assert.ok(!isAllowedHost("192.168.1.20:4321", 4321, "127.0.0.1"));
  });

  it("rejects a missing Host header and a mismatched port", () => {
    assert.ok(!isAllowedHost(undefined, 4321, "127.0.0.1"));
    assert.ok(!isAllowedHost("127.0.0.1:9999", 4321, "127.0.0.1"));
  });

  it("accepts the explicitly bound host", () => {
    assert.ok(isAllowedHost("10.0.0.5:80", 80, "10.0.0.5"));
  });
});

describe("startLiveReportServer (#228)", () => {
  it("serves the report page with live polling enabled", async () => {
    running = await startLiveReportServer({ load: async () => [makeEvent()] });
    const res = await fetch(running.url);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.ok(html.startsWith("<!DOCTYPE html>"));
    // Live pages must be allowed to talk to their own origin (#228).
    assert.ok(html.includes("connect-src 'self'"));
    assert.ok(html.includes('id="livePill"'));
    assert.match(html, /const LIVE = \{[^}]*"pollMs":\d+/);
  });

  it("serves the aggregated payload and a matching signature", async () => {
    running = await startLiveReportServer({
      load: async () => [makeEvent({ id: "a" }), makeEvent({ id: "b", source: "user" })],
    });
    const state = await fetch(new URL("api/state", running.url)).then((r) => r.json());
    const payload = await fetch(new URL("api/data", running.url)).then((r) => r.json());
    assert.equal(payload.signature, state.signature);
    assert.equal(payload.data.events.length, 2);
    assert.equal(payload.data.stats.total, 2);
    assert.equal(payload.data.stats.autoRate, 50);
    assert.deepEqual(payload.data.topSkills[0][0], "pdf");
  });

  it("re-reads the store only when the revision token changes", async () => {
    let events = [makeEvent({ id: "a" })];
    let token = "rev-1";
    let loads = 0;
    running = await startLiveReportServer({
      load: async () => {
        loads++;
        return events;
      },
      revision: async () => token,
    });

    const first = await fetch(new URL("api/state", running.url)).then((r) => r.json());
    await fetch(new URL("api/state", running.url));
    await fetch(new URL("api/state", running.url));
    assert.equal(loads, 1, "unchanged store must not be re-read on every poll");

    events = [makeEvent({ id: "a" }), makeEvent({ id: "c" })];
    token = "rev-2";
    const second = await fetch(new URL("api/state", running.url)).then((r) => r.json());
    assert.equal(loads, 2);
    assert.notEqual(second.signature, first.signature);
  });

  it("keeps the signature stable across reloads that change nothing", async () => {
    let token = "rev-1";
    running = await startLiveReportServer({
      load: async () => [makeEvent()],
      revision: async () => token,
    });
    const first = await fetch(new URL("api/state", running.url)).then((r) => r.json());
    token = "rev-2"; // file touched, contents identical
    const second = await fetch(new URL("api/state", running.url)).then((r) => r.json());
    assert.equal(second.signature, first.signature);
  });

  it("rejects a rebound Host header, unknown paths and non-GET methods", async () => {
    running = await startLiveReportServer({ load: async () => [] });
    assert.equal(await rawGet(running.port, "/", "evil.example.com"), 403);
    assert.equal(await rawGet(running.port, "/api/data", "evil.example.com"), 403);
    assert.equal(await rawGet(running.port, "/", `127.0.0.1:${running.port}`), 200);
    assert.equal((await fetch(new URL("nope", running.url))).status, 404);
    assert.equal((await fetch(running.url, { method: "POST" })).status, 405);
  });

  it("reports a failing store as a 500 instead of crashing the server", async () => {
    running = await startLiveReportServer({
      load: async () => {
        throw new Error("store is on fire");
      },
    });
    const res = await fetch(new URL("api/data", running.url));
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /store is on fire/);
    // Still listening afterwards.
    assert.equal((await fetch(new URL("nope", running.url))).status, 404);
  });

  it("binds loopback on a free port by default", async () => {
    running = await startLiveReportServer({ load: async () => [] });
    assert.ok(running.port > 0);
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(DEFAULT_LIVE_POLL_MS, 2000);
  });
});
