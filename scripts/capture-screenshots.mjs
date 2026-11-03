#!/usr/bin/env node
// Regenerates the README screenshots in docs/assets/ (#112).
//
//   npm run build
//   node scripts/capture-screenshots.mjs [--chartjs <path/to/chart.umd.js>]
//
// It fabricates a deterministic sample event store in a temp directory (no
// real ~/.claude data is ever read), renders `cc-skill-trace show` and
// `cc-skill-trace report` from dist/ against it, and screenshots both with
// Playwright. Playwright is NOT a dependency of this package — install it
// ad hoc (`npx playwright install chromium` + `npm i --no-save playwright`)
// or run where it is already available.
//
// The HTML report loads Chart.js from cdn.jsdelivr.net. Where that host is
// unreachable, pass --chartjs with a local copy (e.g. from `npm pack
// chart.js@4.4.8`) and the CDN request is answered from that file instead.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli", "index.js");
const outDir = join(root, "docs", "assets");

const argv = process.argv.slice(2);
const chartjsIdx = argv.indexOf("--chartjs");
const chartjsPath = chartjsIdx >= 0 ? resolve(argv[chartjsIdx + 1] ?? "") : null;

// ─── Sample data ──────────────────────────────────────────────────────────────

// Small seeded PRNG (mulberry32) so every run produces the same store.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKILLS = [
  {
    name: "commit",
    weight: 9,
    auto: 0.75,
    tokens: 1400,
    triggers: [
      "commit this change",
      "tests passed, please open a PR",
      "ok, let's save this progress",
      "looks good, ship it",
    ],
  },
  {
    name: "review-pr",
    weight: 5,
    auto: 0.4,
    tokens: 2600,
    triggers: ["/review-pr 123", "can you take a look at the open PR?", "/review-pr 128"],
  },
  {
    name: "write-tests",
    weight: 4,
    auto: 0.8,
    tokens: 1900,
    triggers: ["add coverage for the parser", "this needs a regression test"],
  },
  {
    name: "security-review",
    weight: 2,
    auto: 0.9,
    tokens: 3100,
    triggers: ["is this safe to merge?", "check the auth flow"],
  },
  {
    name: "release-notes",
    weight: 2,
    auto: 0.3,
    tokens: 900,
    triggers: ["/release-notes v3.0.0", "draft the changelog"],
  },
  {
    name: "db-migrate",
    weight: 1,
    auto: 1,
    tokens: 2200,
    triggers: ["rename the users.email column"],
  },
];
const BRANCHES = ["main", "feat/live-report", "fix/scan-dedupe", "docs/screenshots"];

function sampleEvents() {
  const rand = prng(112);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const totalWeight = SKILLS.reduce((s, k) => s + k.weight, 0);
  const pickSkill = () => {
    let r = rand() * totalWeight;
    for (const s of SKILLS) {
      r -= s.weight;
      if (r <= 0) return s;
    }
    return SKILLS[0];
  };

  const now = Date.now();
  const events = [];
  for (let i = 0; i < 72; i++) {
    const skill = pickSkill();
    // Denser activity in the last few days, sparse further back (30-day span).
    const daysAgo = rand() ** 1.8 * 30;
    const ts = new Date(now - daysAgo * 86_400_000 - rand() * 3_600_000);
    // Keep timestamps within working hours so the hour histogram looks real.
    ts.setHours(9 + Math.floor(rand() * 10), Math.floor(rand() * 60), Math.floor(rand() * 60));
    if (ts.getTime() > now) ts.setTime(now - (i + 1) * 97_000);
    const source = rand() < skill.auto ? "claude" : "user";
    const trigger = pick(skill.triggers);
    const viaHook = rand() < 0.7;
    events.push({
      id: `sample-${String(i).padStart(3, "0")}`,
      v: 3,
      timestamp: ts.toISOString(),
      sessionId: `session-${Math.floor(daysAgo * 2)}`,
      skillName: skill.name,
      source: trigger.startsWith("/") ? "user" : source,
      triggerMessage: trigger,
      injectedTokens: Math.round(skill.tokens * (0.85 + rand() * 0.3)),
      cwd: "/home/dev/projects/acme-api",
      gitBranch: pick(BRANCHES),
      recordedVia: viaHook ? "hook" : "scan",
      ...(viaHook
        ? {
            outcome: rand() < 0.93 ? "success" : "error",
            durationMs: Math.round(800 + rand() * 9000),
          }
        : {}),
      provider: "claude-code",
    });
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}

// ─── ANSI → HTML ─────────────────────────────────────────────────────────────

// Terminal palette (close to a typical dark theme) for the 16 base colors.
const BASE = [
  "#1e1e2e", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#cba6f7", "#94e2d5", "#cdd6f4",
  "#6c7086", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#cba6f7", "#94e2d5", "#ffffff",
];

function xterm256(n) {
  if (n < 16) return BASE[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ansiToHtml(text) {
  let state = {};
  let html = "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control chars
  const re = /\x1B\[([0-9;]*)m/g;
  let last = 0;
  const flush = (chunk) => {
    if (!chunk) return;
    const css = [];
    if (state.fg) css.push(`color:${state.fg}`);
    if (state.bg) css.push(`background:${state.bg}`);
    if (state.bold) css.push("font-weight:700");
    if (state.dim) css.push("opacity:.6");
    if (state.italic) css.push("font-style:italic");
    if (state.underline) css.push("text-decoration:underline");
    html += css.length ? `<span style="${css.join(";")}">${escapeHtml(chunk)}</span>` : escapeHtml(chunk);
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    flush(text.slice(last, m.index));
    last = re.lastIndex;
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) state = {};
      else if (c === 1) state.bold = true;
      else if (c === 2) state.dim = true;
      else if (c === 3) state.italic = true;
      else if (c === 4) state.underline = true;
      else if (c === 22) state.bold = state.dim = false;
      else if (c === 23) state.italic = false;
      else if (c === 24) state.underline = false;
      else if (c >= 30 && c <= 37) state.fg = BASE[c - 30];
      else if (c >= 90 && c <= 97) state.fg = BASE[c - 90 + 8];
      else if (c === 39) state.fg = undefined;
      else if (c >= 40 && c <= 47) state.bg = BASE[c - 40];
      else if (c >= 100 && c <= 107) state.bg = BASE[c - 100 + 8];
      else if (c === 49) state.bg = undefined;
      else if (c === 38 || c === 48) {
        const key = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5) {
          state[key] = xterm256(codes[i + 2]);
          i += 2;
        } else if (codes[i + 1] === 2) {
          state[key] = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
          i += 4;
        }
      }
    }
  }
  flush(text.slice(last));
  return html;
}

function terminalPage(ansi) {
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#11111b}
  .win{display:inline-block;margin:24px;border-radius:10px;background:#1e1e2e;
       box-shadow:0 10px 40px rgba(0,0,0,.5);overflow:hidden}
  .bar{height:30px;background:#181825;display:flex;align-items:center;gap:8px;padding:0 14px}
  .dot{width:12px;height:12px;border-radius:50%}
  .title{color:#6c7086;font:13px system-ui,sans-serif;margin-left:10px}
  pre{margin:0;padding:16px 22px 20px;color:#cdd6f4;
      font:14px/1.45 "JetBrains Mono","DejaVu Sans Mono",monospace,"Noto Color Emoji"}
  </style><div class="win"><div class="bar">
  <span class="dot" style="background:#f38ba8"></span><span class="dot" style="background:#f9e2af"></span>
  <span class="dot" style="background:#a6e3a1"></span><span class="title">~/projects/acme-api — cc-skill-trace show</span>
  </div><pre>${ansiToHtml(ansi)}</pre></div>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

// Plain `import("playwright")` ignores NODE_PATH, where a globally installed
// Playwright usually lives, so fall back to require() which honors it.
async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    try {
      return createRequire(import.meta.url)("playwright");
    } catch {
      console.error("playwright is not installed — see the header of this script.");
      process.exit(1);
    }
  }
}
const { chromium } = await loadPlaywright();

const tmp = mkdtempSync(join(tmpdir(), "cc-skill-trace-shots-"));
try {
  const store = join(tmp, "store");
  mkdirSync(store, { recursive: true });
  writeFileSync(
    join(store, "events.jsonl"),
    `${sampleEvents()
      .map((e) => JSON.stringify(e))
      .join("\n")}\n`
  );
  // No npm update hint in the screenshot (and no network call while capturing).
  writeFileSync(join(store, "config.json"), JSON.stringify({ updateCheck: false }));
  const env = {
    ...process.env,
    HOME: tmp, // keep config/state reads away from the real home directory
    USERPROFILE: tmp,
    CC_STORE_DIR: store,
    FORCE_COLOR: "3",
    COLUMNS: "96",
  };
  delete env.NO_COLOR;

  const ansi = execFileSync(process.execPath, [cli, "show", "-n", "100", "--per-page", "6"], { env, encoding: "utf-8" });
  const reportPath = join(tmp, "report.html");
  execFileSync(
    process.execPath,
    [cli, "report", "--no-open", "--theme", "dark", "-o", reportPath],
    { env, encoding: "utf-8" }
  );

  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    // Terminal dashboard
    const term = await browser.newPage({ deviceScaleFactor: 2 });
    await term.setContent(terminalPage(ansi));
    await term
      .locator(".win")
      .screenshot({ path: join(outDir, "dashboard.png"), omitBackground: false });
    await term.close();

    // HTML report
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: "dark",
    });
    if (chartjsPath) {
      // The report pins the CDN file with an SRI hash; a local copy from npm is
      // not byte-identical to jsDelivr's minified build, so drop the integrity
      // attribute from this throwaway copy of the report only.
      const html = readFileSync(reportPath, "utf-8");
      writeFileSync(reportPath, html.replace(/\s+integrity="[^"]*"/, ""));
      const body = readFileSync(chartjsPath);
      await page.route("https://cdn.jsdelivr.net/**", (route) =>
        route.fulfill({ status: 200, contentType: "application/javascript", body })
      );
    }
    await page.goto(`file://${reportPath}`);
    await page.waitForTimeout(1500); // let Chart.js finish its entry animation
    await page.screenshot({ path: join(outDir, "report.png") });
    await page.close();
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${join(outDir, "dashboard.png")} and ${join(outDir, "report.png")}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
