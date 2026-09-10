// Local HTTP server behind `report --watch` (#228).
//
// `show --follow` live-tails the terminal dashboard, but the HTML report has
// always been a static snapshot: seeing a new invocation meant re-running
// `report` and reloading the tab. This server closes that asymmetry without
// giving up the standalone report — the plain `report` command still writes a
// dependency-free `file://` page, and only `--watch` starts a server.
//
// Design notes:
//   - `node:http` only. "Zero dependencies" means zero *npm* dependencies, so
//     a built-in module is fair game.
//   - Bound to loopback by default, and every request's `Host` header is
//     checked against the address we actually listen on. That blocks DNS
//     rebinding, where a page on the public internet resolves its own hostname
//     to 127.0.0.1 to read a local server's responses same-origin.
//   - The browser polls `/api/state`, which is a signature string. The full
//     payload is only re-sent from `/api/data` when that signature changed,
//     and the events file is only re-read when its size/mtime moved.

import { createHash } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SkillInvocationEvent } from "../core/types.js";
import {
  type HtmlReportOptions,
  type ReportData,
  computeReportData,
  renderHtmlReport,
} from "./web-report.js";

/** Default interval at which the served page polls for new events. */
export const DEFAULT_LIVE_POLL_MS = 2000;

/** Options for {@link startLiveReportServer}. */
export interface LiveReportServerOptions {
  /** Load the (already filtered) events to report on. */
  load: () => Promise<SkillInvocationEvent[]>;
  /**
   * Cheap change token for the underlying store — typically the events file's
   * size and mtime. A changed token triggers a reload via {@link load};
   * an unchanged one skips it. Omit to reload on every poll.
   */
  revision?: () => Promise<string>;
  /** Report rendering options (theme, redaction). */
  report?: Omit<HtmlReportOptions, "live">;
  /** How often the browser polls, in milliseconds. */
  pollMs?: number;
  /** Interface to bind. Defaults to loopback; changing it exposes your events. */
  host?: string;
  /** Port to bind. 0 (the default) picks a free one. */
  port?: number;
}

/** A running live-report server. */
export interface LiveReportServer {
  /** URL to open in a browser. */
  url: string;
  /** The port actually bound (useful when `port: 0` was requested). */
  port: number;
  /** The underlying Node server, exposed for tests and advanced callers. */
  server: Server;
  /** Stop listening and resolve once all connections are closed. */
  close: () => Promise<void>;
}

/**
 * Accept only requests whose `Host` header points at the loopback address (or
 * the exact host we were told to bind). Anything else is a cross-host request
 * we never intend to serve — most importantly a DNS-rebinding attempt.
 */
export function isAllowedHost(hostHeader: string | undefined, port: number, bindHost: string) {
  if (!hostHeader) return false;
  // Strip the port. IPv6 literals arrive bracketed: "[::1]:8080".
  const host = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : (hostHeader.split(":")[0] ?? "");
  const portPart = hostHeader.slice(host.length);
  if (portPart && portPart !== `:${port}`) return false;
  const allowed = new Set(["localhost", "127.0.0.1", "[::1]", "::1", bindHost, `[${bindHost}]`]);
  return allowed.has(host);
}

/** Signature of a payload's meaningful content. `generatedAt` is deliberately
 *  excluded so an unchanged store never looks like an update to the browser. */
function signatureOf(data: ReportData): string {
  return createHash("sha256").update(JSON.stringify(data.events)).digest("hex").slice(0, 16);
}

/** Holds the current payload and refreshes it only when the store moved. */
class Snapshot {
  private data: ReportData | null = null;
  private signature = "";
  private token: string | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly opts: LiveReportServerOptions) {}

  /** Current payload, reloading first if the store changed. */
  async current(): Promise<{ data: ReportData; signature: string }> {
    // Collapse concurrent refreshes: the browser polls on a timer and a
    // reload can outlive one interval on a large store.
    if (!this.inFlight) {
      this.inFlight = this.refresh().finally(() => {
        this.inFlight = null;
      });
    }
    await this.inFlight;
    // `refresh` always leaves `data` set, but keep the fallback total.
    const data = this.data ?? computeReportData([], this.opts.report);
    return { data, signature: this.signature };
  }

  private async refresh(): Promise<void> {
    const token = this.opts.revision ? await this.opts.revision() : null;
    if (this.data && token !== null && token === this.token) return;
    const events = await this.opts.load();
    this.data = computeReportData(events, this.opts.report);
    this.signature = signatureOf(this.data);
    this.token = token;
  }
}

/**
 * Start the live report server and resolve once it is listening.
 *
 * Routes: `/` (the report page), `/api/state` (signature only) and
 * `/api/data` (the full payload). Everything else is a 404 — no static file
 * serving, so there is no path to traverse.
 */
export async function startLiveReportServer(
  opts: LiveReportServerOptions
): Promise<LiveReportServer> {
  const host = opts.host ?? "127.0.0.1";
  const pollMs = Math.max(250, opts.pollMs ?? DEFAULT_LIVE_POLL_MS);
  const snapshot = new Snapshot(opts);

  const server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, type: string, body: string) => {
        res.writeHead(status, {
          "Content-Type": type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(req.method === "HEAD" ? undefined : body);
      };

      try {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return send(405, "text/plain; charset=utf-8", "Method Not Allowed");
        }
        const port = (server.address() as AddressInfo | null)?.port ?? 0;
        if (!isAllowedHost(req.headers.host, port, host)) {
          return send(403, "text/plain; charset=utf-8", "Forbidden");
        }

        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path === "/api/state") {
          const { signature } = await snapshot.current();
          return send(200, "application/json; charset=utf-8", JSON.stringify({ signature }));
        }
        if (path === "/api/data") {
          const { data, signature } = await snapshot.current();
          return send(200, "application/json; charset=utf-8", JSON.stringify({ signature, data }));
        }
        if (path === "/" || path === "/index.html") {
          const { data, signature } = await snapshot.current();
          const html = renderHtmlReport(data, { ...opts.report, live: { pollMs, signature } });
          return send(200, "text/html; charset=utf-8", html);
        }
        return send(404, "text/plain; charset=utf-8", "Not Found");
      } catch (err) {
        // A broken store shouldn't kill the watch loop — report it and keep
        // serving, so the next poll can recover once the file is readable.
        const msg = err instanceof Error ? err.message : String(err);
        send(500, "application/json; charset=utf-8", JSON.stringify({ error: msg }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const displayHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${displayHost}:${port}/`,
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
