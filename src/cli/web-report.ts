import type { SkillInvocationEvent } from "../core/types.js";

/** Escape HTML special chars (server-side, TypeScript) */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Safely embed a value as JSON inside a <script> tag.
 *  Escapes "</" to prevent early </script> termination. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/<\//g, "<\\/");
}

/** Per-skill invocation counts behind the report's charts. */
export interface ReportSkillCounts {
  /** Total invocations of the skill. */
  total: number;
  /** Invocations explicitly requested by the user. */
  byUser: number;
  /** Invocations auto-triggered by the assistant. */
  byClaude: number;
}

/** Live-update settings embedded into a report served by `report --watch` (#228). */
export interface LiveReportSettings {
  /** How often the page polls the server's `/api/state`, in milliseconds. */
  pollMs: number;
  /** Signature of the embedded payload, compared against `/api/state`. */
  signature: string;
}

/** Options for {@link buildHtmlReport}. */
export interface HtmlReportOptions {
  /** Initial color theme (#150). "auto" follows prefers-color-scheme. */
  theme?: "dark" | "light" | "auto";
  /** Mask trigger messages before embedding them (#108). */
  redactTriggers?: boolean;
  /**
   * When set, the page polls a local server for new events and re-renders in
   * place instead of staying a static snapshot (#228). Set by `report --watch`;
   * a report generated without it keeps working as a standalone `file://` page.
   */
  live?: LiveReportSettings;
}

/**
 * Everything the report page renders, in one serializable payload.
 *
 * `report --watch` serves this from `/api/data` so the browser can refresh the
 * charts and the event table in place rather than reloading the whole page (#228).
 */
export interface ReportData {
  /** Events, oldest first (already redacted when requested). */
  events: SkillInvocationEvent[];
  /** Top 20 skills by invocation count. */
  topSkills: [string, ReportSkillCounts][];
  /** Per-day invocation counts, ascending by day. */
  byDay: { day: string; count: number }[];
  /** Skill x hour-of-day heatmap for the top skills (#46). */
  heatmap: { skills: string[]; rows: number[][] };
  /** Top 10 git branches by invocation count (#101). */
  branches: [string, number][];
  /** Headline numbers shown in the stat cards. */
  stats: { total: number; autoRate: number; uniqueSkills: number; activeDays: number };
  /** ISO timestamp of when this payload was computed. */
  generatedAt: string;
}

/**
 * Aggregate raw events into everything the report page needs.
 *
 * Kept separate from rendering so the live server can recompute the payload
 * without re-generating the surrounding HTML shell (#228).
 */
export function computeReportData(
  events: SkillInvocationEvent[],
  opts: { redactTriggers?: boolean } = {}
): ReportData {
  // -- Privacy: redact trigger messages before anything is embedded (#108) --
  const sourceEvents: SkillInvocationEvent[] = opts.redactTriggers
    ? events.map((ev) => (ev.triggerMessage ? { ...ev, triggerMessage: "[redacted]" } : ev))
    : events;

  // -- Aggregation -----------------------------------------------------------
  const skillCounts: Record<string, ReportSkillCounts> = {};
  for (const ev of sourceEvents) {
    const counts = skillCounts[ev.skillName] ?? { total: 0, byUser: 0, byClaude: 0 };
    skillCounts[ev.skillName] = counts;
    counts.total++;
    if (ev.source === "user") counts.byUser++;
    else counts.byClaude++;
  }

  const topSkills: [string, ReportSkillCounts][] = Object.entries(skillCounts)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20);

  const autoRate =
    sourceEvents.length === 0
      ? 0
      : Math.round(
          (sourceEvents.filter((e) => e.source === "claude").length / sourceEvents.length) * 100
        );

  // Group by day for timeline
  const byDay: Record<string, number> = {};
  for (const ev of sourceEvents) {
    const day = ev.timestamp.slice(0, 10);
    byDay[day] = (byDay[day] ?? 0) + 1;
  }

  // Skill x hour-of-day heatmap for the top skills (#46)
  const heatSkills = topSkills.slice(0, 8).map(([name]) => name);
  const heatmap: Record<string, number[]> = {};
  for (const name of heatSkills) heatmap[name] = new Array<number>(24).fill(0);
  for (const ev of sourceEvents) {
    const row = heatmap[ev.skillName];
    if (!row) continue;
    const h = new Date(ev.timestamp).getHours();
    if (h >= 0 && h < 24) row[h] = (row[h] ?? 0) + 1;
  }

  // Per-git-branch counts (#101)
  const byBranch: Record<string, number> = {};
  for (const ev of sourceEvents) {
    if (!ev.gitBranch) continue;
    byBranch[ev.gitBranch] = (byBranch[ev.gitBranch] ?? 0) + 1;
  }
  const topBranches: [string, number][] = Object.entries(byBranch)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  return {
    events: sourceEvents,
    topSkills,
    byDay: Object.entries(byDay)
      .sort()
      .map(([day, count]) => ({ day, count })),
    heatmap: { skills: heatSkills, rows: heatSkills.map((s) => heatmap[s] ?? []) },
    branches: topBranches,
    stats: {
      total: sourceEvents.length,
      autoRate,
      uniqueSkills: Object.keys(skillCounts).length,
      activeDays: Object.keys(byDay).length,
    },
    generatedAt: new Date().toISOString(),
  };
}

/** Build a standalone HTML file that visualizes skill invocations */
export function buildHtmlReport(
  events: SkillInvocationEvent[],
  opts: HtmlReportOptions = {}
): string {
  return renderHtmlReport(computeReportData(events, opts), opts);
}

/**
 * Render a pre-computed {@link ReportData} payload as an HTML page.
 *
 * `buildHtmlReport` is the usual entry point; the live server calls this
 * directly with a payload it already holds (#228).
 */
export function renderHtmlReport(data: ReportData, opts: HtmlReportOptions = {}): string {
  const theme = opts.theme ?? "auto";
  const live = opts.live ?? null;
  // The static report never talks to the network beyond the Chart.js CDN, so
  // it keeps `connect-src 'none'`. Live mode needs to poll its own origin.
  const connectSrc = live ? "'self'" : "'none'";
  const dataJson = safeJson(data);

  return /* html */ `<!DOCTYPE html>
<html lang="en" data-theme="${theme === "auto" ? "" : theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; connect-src ${connectSrc}; frame-src 'none'; object-src 'none';">
<title>cc-skill-trace — Skill Invocation Report</title>
<!-- Loaded synchronously: by the time the end-of-body script runs, Chart is
     either defined or the load failed, and renderCharts() renders a fallback. -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"
  integrity="sha384-T/4KgSWuZEPozpPz7rnnp/5lDSnpY1VPJCojf1S81uTHS1E38qgLfMgVsAeRCWc4"
  crossorigin="anonymous"></script>
<style>
  .cdn-error { color: var(--muted); font-size: 12px; padding: 24px 0; text-align: center; }
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #f78166;
    --claude: #a78bfa; --user: #38bdf8; --yellow: #d4a72c;
    --heat0: #161b22;
  }
  [data-theme="light"] {
    --bg: #ffffff; --surface: #f6f8fa; --border: #d0d7de;
    --text: #1f2328; --muted: #59636e; --accent: #cf3e0c;
    --claude: #6639ba; --user: #0969da; --yellow: #7d4e00;
    --heat0: #f6f8fa;
  }
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]):not([data-theme="light"]) {
      --bg: #ffffff; --surface: #f6f8fa; --border: #d0d7de;
      --text: #1f2328; --muted: #59636e; --accent: #cf3e0c;
      --claude: #6639ba; --user: #0969da; --yellow: #7d4e00;
      --heat0: #f6f8fa;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
  .header { padding: 24px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 18px; font-weight: 700; }
  .header .badge { background: var(--accent); color: var(--bg); border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 700; }
  .header .meta { margin-left: auto; color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 12px; }
  #themeToggle { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 4px 10px; cursor: pointer; font-family: inherit; font-size: 12px; }
  /* Live-mode status pill (#228) */
  #livePill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border); border-radius: 20px; padding: 3px 10px; font-size: 11px; color: var(--muted); }
  #livePill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
  #livePill[data-state="live"] .dot { background: #3fb950; }
  #livePill[data-state="updated"] { border-color: var(--accent); color: var(--accent); }
  #livePill[data-state="updated"] .dot { background: var(--accent); }
  #livePill[data-state="offline"] { border-color: var(--yellow); color: var(--yellow); }
  #livePill[data-state="offline"] .dot { background: var(--yellow); }
  #themeToggle:focus-visible, .filter-btn:focus-visible, .event-card:focus-visible, #loadMoreBtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; padding: 24px 32px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat-card .value { font-size: 32px; font-weight: 700; color: var(--yellow); }
  .stat-card .label { color: var(--muted); margin-top: 4px; font-size: 12px; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 32px 24px; }
  .chart-box { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  .chart-box h2, .timeline h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.08em; }
  canvas { max-height: 280px; }
  .heat-grid { display: grid; grid-template-columns: 110px repeat(24, 1fr); gap: 2px; align-items: center; }
  .heat-grid .hlabel { font-size: 10px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-right: 6px; }
  .heat-cell { aspect-ratio: 1; border-radius: 2px; background: var(--heat0); min-width: 6px; }
  .heat-hours { display: grid; grid-template-columns: 110px repeat(24, 1fr); gap: 2px; margin-top: 4px; }
  .heat-hours span { font-size: 9px; color: var(--muted); text-align: center; }
  .branch-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .branch-row .bname { width: 160px; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .branch-row .bbar { height: 12px; background: var(--user); border-radius: 3px; min-width: 2px; }
  .branch-row .bcount { font-size: 11px; color: var(--text); }
  .timeline { padding: 0 32px 32px; }
  .event-list { display: flex; flex-direction: column; gap: 8px; }
  .event-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; display: grid; grid-template-columns: 140px 160px 80px 1fr; align-items: start; gap: 12px; cursor: pointer; transition: border-color 0.15s; text-align: left; width: 100%; font-family: inherit; font-size: inherit; color: inherit; }
  .event-card:hover { border-color: var(--accent); }
  .event-card .time { color: var(--muted); font-size: 11px; }
  .event-card .skill { color: var(--yellow); font-weight: 700; }
  .event-card .source-badge { display: inline-block; border-radius: 3px; padding: 1px 6px; font-size: 11px; font-weight: 600; }
  .source-claude { background: color-mix(in srgb, var(--claude) 18%, transparent); color: var(--claude); }
  .source-user   { background: color-mix(in srgb, var(--user) 18%, transparent); color: var(--user); }
  .event-card .trigger { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail-panel { background: var(--bg); border: 1px solid var(--accent); border-radius: 6px; padding: 16px; margin-top: 4px; display: none; grid-column: 1 / -1; font-size: 12px; line-height: 1.6; }
  .detail-panel .label { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
  .detail-panel .content { color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .search-bar { padding: 0 32px 16px; }
  input[type=text] { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 8px 14px; font-family: inherit; font-size: 13px; outline: none; }
  input[type=text]:focus { border-color: var(--accent); }
  .filter-row { padding: 0 32px 16px; display: flex; gap: 10px; flex-wrap: wrap; }
  .filter-btn { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; color: var(--muted); padding: 4px 14px; cursor: pointer; font-family: inherit; font-size: 12px; transition: all 0.15s; }
  .filter-btn[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
  #loadMoreBtn { display: none; margin: 16px auto 0; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--muted); padding: 8px 24px; cursor: pointer; font-family: inherit; font-size: 12px; transition: border-color 0.15s; }
  #loadMoreBtn:hover { border-color: var(--accent); color: var(--accent); }
  @media (max-width: 900px) { .charts { grid-template-columns: 1fr; } .event-card { grid-template-columns: 1fr 1fr; } }
  /* Print / PDF (#164): white background, no interactive chrome, no clipping */
  @media print {
    :root, [data-theme="dark"] { --bg: #ffffff; --surface: #ffffff; --border: #bbbbbb; --text: #000000; --muted: #444444; --accent: #000000; --claude: #6639ba; --user: #0969da; --yellow: #7d4e00; --heat0: #f2f2f2; }
    body { font-size: 11px; }
    .search-bar, .filter-row, #loadMoreBtn, #themeToggle { display: none !important; }
    .event-card, .chart-box, .stat-card { break-inside: avoid; border-color: #bbbbbb; }
    .event-card .trigger { white-space: normal; }
  }
</style>
</head>
<body>

<div class="header">
  <span aria-hidden="true">🔍</span>
  <h1>cc-skill-trace</h1>
  <span class="badge">Skill Invocation Report</span>
  <span class="meta">
    ${live ? '<span id="livePill" data-state="live" role="status" aria-live="polite"><span class="dot" aria-hidden="true"></span><span id="livePillText">live</span></span>' : ""}
    <span id="generatedAt">Generated: ${escapeHtml(new Date(data.generatedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}</span>
    <button id="themeToggle" type="button" aria-label="Toggle color theme">◐ theme</button>
  </span>
</div>

<div class="stats" role="group" aria-label="Summary statistics">
  <div class="stat-card">
    <div class="value" id="statTotal">${data.stats.total}</div>
    <div class="label">Total Invocations</div>
  </div>
  <div class="stat-card">
    <div class="value" id="statAutoRate" style="color:var(--claude)">${data.stats.autoRate}%</div>
    <div class="label">Auto-triggered by Claude</div>
  </div>
  <div class="stat-card">
    <div class="value" id="statSkills" style="color:var(--yellow)">${data.stats.uniqueSkills}</div>
    <div class="label">Unique Skills Used</div>
  </div>
  <div class="stat-card">
    <div class="value" id="statDays" style="color:var(--user)">${data.stats.activeDays}</div>
    <div class="label">Active Days</div>
  </div>
</div>

<div id="charts-section" class="charts">
  <div class="chart-box">
    <h2 id="skillChartTitle">Top Skills by Invocations</h2>
    <canvas id="skillChart" role="img" aria-labelledby="skillChartTitle"></canvas>
  </div>
  <div class="chart-box">
    <h2 id="timelineChartTitle">Daily Invocation Activity</h2>
    <canvas id="timelineChart" role="img" aria-labelledby="timelineChartTitle"></canvas>
  </div>
  <div class="chart-box">
    <h2>Skill × Hour Heatmap</h2>
    <div id="heatmap" role="img" aria-label="Heatmap of skill invocations by hour of day"></div>
  </div>
  <div class="chart-box">
    <h2>Invocations by Git Branch</h2>
    <div id="branches" role="img" aria-label="Invocation counts per git branch"></div>
  </div>
</div>

<div class="filter-row" role="group" aria-label="Source filter">
  <button class="filter-btn" data-filter="all" aria-pressed="true" type="button">All</button>
  <button class="filter-btn" data-filter="claude" aria-pressed="false" type="button">🤖 Claude-triggered</button>
  <button class="filter-btn" data-filter="user" aria-pressed="false" type="button">👤 User-triggered</button>
</div>

<div class="search-bar">
  <label for="searchInput" style="position:absolute;left:-9999px">Filter events</label>
  <input type="text" id="searchInput" placeholder="Filter by skill name or trigger message…" />
</div>

<div class="timeline">
  <h2>Invocation Timeline <span id="countLabel" style="font-weight:400;color:var(--muted)" aria-live="polite"></span></h2>
  <div class="event-list" id="eventList"></div>
  <button id="loadMoreBtn" type="button" onclick="loadMore()"></button>
</div>

<script>
let DATA = ${dataJson};
const INITIAL_THEME = ${safeJson(theme)};
// null for a static report; { pollMs, signature } when served by "report --watch" (#228)
const LIVE = ${live ? safeJson(live) : "null"};

let EVENTS = DATA.events;
let TOP_SKILLS = DATA.topSkills;
let BY_DAY = DATA.byDay;
let HEATMAP = DATA.heatmap;
let BRANCHES = DATA.branches;

// ── Theme handling (#150) — persisted in localStorage (#48) ──────────────
const root = document.documentElement;
function currentTheme() {
  return root.dataset.theme ||
    (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}
try {
  const saved = localStorage.getItem('cc-skill-trace-theme');
  if (saved === 'dark' || saved === 'light') root.dataset.theme = saved;
  else if (INITIAL_THEME !== 'auto') root.dataset.theme = INITIAL_THEME;
} catch (e) { /* storage unavailable (file:// privacy modes) */ }
document.getElementById('themeToggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('cc-skill-trace-theme', next); } catch (e) {}
});

// ── HTML escaping (client-side) ───────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Charts ────────────────────────────────────────────────────────────────
// Chart instances are kept around so live updates can mutate their data
// instead of tearing down and rebuilding the canvases (#228).
let skillChart = null;
let timelineChart = null;

function renderCharts() {
  if (typeof Chart === 'undefined') {
    // Offline, or the CDN is blocked. Replace only the two <canvas> elements:
    // the heatmap and branch bars are hand-rolled CSS and keep working, so
    // wiping the whole charts section would throw away working content.
    document.querySelectorAll('#skillChart, #timelineChart').forEach(canvas => {
      canvas.outerHTML = '<p class="cdn-error">⚠ Chart.js could not be loaded (no internet connection?). Everything below still works.</p>';
    });
    return;
  }
  const skillLabels = TOP_SKILLS.map(([name]) => name);
  const claudeData = TOP_SKILLS.map(([,d]) => d.byClaude);
  const userData = TOP_SKILLS.map(([,d]) => d.byUser);
  const dayLabels = BY_DAY.map(d => d.day);
  const dayData = BY_DAY.map(d => d.count);

  if (skillChart) {
    skillChart.data.labels = skillLabels;
    skillChart.data.datasets[0].data = claudeData;
    skillChart.data.datasets[1].data = userData;
    skillChart.update();
  } else {
    const skillCtx = document.getElementById('skillChart').getContext('2d');
    skillChart = new Chart(skillCtx, {
      type: 'bar',
      data: {
        labels: skillLabels,
        datasets: [
          { label: 'Claude', data: claudeData, backgroundColor: '#a78bfa80', borderColor: '#a78bfa', borderWidth: 1 },
          { label: 'User',   data: userData,   backgroundColor: '#38bdf880', borderColor: '#38bdf8', borderWidth: 1 },
        ]
      },
      options: { responsive: true, plugins: { legend: { labels: { color: '#8b949e' } } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d40' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d40' } } } }
    });
  }

  if (timelineChart) {
    timelineChart.data.labels = dayLabels;
    timelineChart.data.datasets[0].data = dayData;
    timelineChart.update();
  } else {
    const tlCtx = document.getElementById('timelineChart').getContext('2d');
    timelineChart = new Chart(tlCtx, {
      type: 'line',
      data: {
        labels: dayLabels,
        datasets: [{ label: 'Invocations', data: dayData, borderColor: '#f78166', backgroundColor: '#f7816620', fill: true, tension: 0.3 }]
      },
      options: { responsive: true, plugins: { legend: { labels: { color: '#8b949e' } } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d40' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d40' } } } }
    });
  }
}
renderCharts();

// ── Skill × hour heatmap (#46) — pure CSS grid, no chart library ─────────
function renderHeatmap() {
  const el = document.getElementById('heatmap');
  if (!el) return;
  if (!HEATMAP.skills.length) { el.innerHTML = '<p style="color:var(--muted);font-size:12px">No data.</p>'; return; }
  const max = Math.max(1, ...HEATMAP.rows.flat());
  let html = '<div class="heat-grid">';
  HEATMAP.skills.forEach((name, r) => {
    html += '<span class="hlabel" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>';
    HEATMAP.rows[r].forEach((count, h) => {
      const alpha = count === 0 ? 0 : 0.15 + 0.85 * (count / max);
      const style = count === 0 ? '' : ' style="background:color-mix(in srgb, var(--claude) ' + Math.round(alpha * 100) + '%, var(--heat0))"';
      html += '<span class="heat-cell"' + style + ' title="' + escapeHtml(name) + ' @ ' + h + ':00 — ' + count + 'x"></span>';
    });
  });
  html += '</div><div class="heat-hours"><span></span>';
  for (let h = 0; h < 24; h++) html += '<span>' + (h % 6 === 0 ? h : '') + '</span>';
  html += '</div>';
  el.innerHTML = html;
}
renderHeatmap();

// ── Git-branch bars (#101) ────────────────────────────────────────────────
function renderBranches() {
  const el = document.getElementById('branches');
  if (!el) return;
  if (!BRANCHES.length) { el.innerHTML = '<p style="color:var(--muted);font-size:12px">No branch data — events captured by the hook include the git branch automatically.</p>'; return; }
  const max = BRANCHES[0][1];
  el.innerHTML = BRANCHES.map(([name, count]) =>
    '<div class="branch-row"><span class="bname" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
    '<span class="bbar" style="width:' + Math.max(2, Math.round((count / max) * 60)) + '%"></span>' +
    '<span class="bcount">' + count + 'x</span></div>'
  ).join('');
}
renderBranches();

// ── Event list with pagination and debounced search (#19) ────────────────
const PAGE_SIZE = 100;
let currentFilter = 'all';
let currentSearch = '';
let currentPage = 0;
let filteredEvents = [];
// Keyed by event ID so detail panels remain correct after filter changes
let eventById = new Map(EVENTS.map(ev => [ev.id, ev]));

// Restore persisted filter/search state (#48)
try {
  const savedFilter = localStorage.getItem('cc-skill-trace-filter');
  const savedSearch = localStorage.getItem('cc-skill-trace-search');
  if (savedFilter === 'claude' || savedFilter === 'user') currentFilter = savedFilter;
  if (savedSearch) { currentSearch = savedSearch; }
} catch (e) {}

function applyFilters() {
  filteredEvents = EVENTS.filter(ev => {
    if (currentFilter === 'claude' && ev.source !== 'claude') return false;
    if (currentFilter === 'user'   && ev.source !== 'user')   return false;
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      if (!ev.skillName.toLowerCase().includes(q) && !(ev.triggerMessage || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }).reverse(); // newest first
}

function eventCardHtml(ev) {
  const time = new Date(ev.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const srcCls = ev.source === 'user' ? 'source-user' : 'source-claude';
  const srcLabel = ev.source === 'user' ? '👤 user' : '🤖 claude';
  const skillDisplay = escapeHtml(ev.skillName) + (ev.skillArgs
    ? \` <span style="color:var(--muted);font-weight:400">\${escapeHtml(ev.skillArgs.slice(0, 30))}</span>\`
    : '');
  const trigger = escapeHtml((ev.triggerMessage || '').slice(0, 100));
  return \`
    <div class="event-card" role="button" tabindex="0" aria-expanded="false" data-event-id="\${escapeHtml(ev.id)}">
      <div class="time">\${escapeHtml(time)}</div>
      <div class="skill">\${skillDisplay}</div>
      <div><span class="source-badge \${srcCls}">\${srcLabel}</span></div>
      <div class="trigger">\${trigger ? '"' + trigger + '"' : '<span style="color:var(--border)">—</span>'}</div>
      <div class="detail-panel"></div>
    </div>\`;
}

function renderList() {
  applyFilters();
  currentPage = 0;
  const showing = Math.min(PAGE_SIZE, filteredEvents.length);
  document.getElementById('countLabel').textContent =
    '(' + showing + ' / ' + filteredEvents.length + ' events)';
  const list = document.getElementById('eventList');
  list.innerHTML = filteredEvents.slice(0, PAGE_SIZE).map(eventCardHtml).join('');
  updateLoadMore();
}

function updateLoadMore() {
  const shown = (currentPage + 1) * PAGE_SIZE;
  const btn = document.getElementById('loadMoreBtn');
  if (shown >= filteredEvents.length) {
    btn.style.display = 'none';
  } else {
    const remaining = filteredEvents.length - shown;
    btn.textContent = 'Load ' + Math.min(PAGE_SIZE, remaining) + ' more  (' + remaining + ' remaining)';
    btn.style.display = 'block';
  }
}

function loadMore() {
  currentPage++;
  const start = currentPage * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  const shown = (currentPage + 1) * PAGE_SIZE;
  const list = document.getElementById('eventList');
  list.insertAdjacentHTML('beforeend', filteredEvents.slice(start, end).map(eventCardHtml).join(''));
  document.getElementById('countLabel').textContent =
    '(' + Math.min(shown, filteredEvents.length) + ' / ' + filteredEvents.length + ' events)';
  updateLoadMore();
}

function toggleDetail(card) {
  const ev = eventById.get(card.dataset.eventId);
  if (!ev) return;
  const panels = card.querySelectorAll('.detail-panel');
  const panel = panels[panels.length - 1];
  if (panel.style.display === 'block') {
    panel.style.display = 'none';
    card.setAttribute('aria-expanded', 'false');
    return;
  }
  const gitBranchHtml = ev.gitBranch
    ? \`<div class="label">GIT BRANCH</div><div class="content" style="margin-bottom:12px">\${escapeHtml(ev.gitBranch)}</div>\`
    : '';
  const tokensHtml = (ev.injectedTokens != null)
    ? \`<div class="label">INJECTED TOKENS</div><div class="content">~\${Number(ev.injectedTokens).toLocaleString()} tokens injected</div>\`
    : '';
  const tagsHtml = (ev.tags && ev.tags.length)
    ? \`<div class="label">TAGS</div><div class="content" style="margin-bottom:12px">\${escapeHtml(ev.tags.join(', '))}</div>\`
    : '';
  const outcomeHtml = ev.outcome
    ? \`<div class="label">OUTCOME</div><div class="content" style="margin-bottom:12px">\${escapeHtml(ev.outcome)}\${ev.durationMs != null ? ' (' + ev.durationMs + 'ms)' : ''}</div>\`
    : '';
  const triggerHtml = ev.triggerMessage
    ? escapeHtml(ev.triggerMessage)
    : '(Not available — run cc-skill-trace scan to backfill)';
  panel.innerHTML = \`
    <div class="label">SESSION ID</div>
    <div class="content" style="margin-bottom:12px">\${escapeHtml(ev.sessionId || '—')}</div>
    <div class="label">TRIGGER MESSAGE</div>
    <div class="content" style="margin-bottom:12px">\${triggerHtml}</div>
    \${gitBranchHtml}
    \${tagsHtml}
    \${outcomeHtml}
    \${tokensHtml}
  \`;
  panel.style.display = 'block';
  card.setAttribute('aria-expanded', 'true');
}

// Event delegation: click + keyboard (Enter/Space) toggling (#174)
const listEl = document.getElementById('eventList');
listEl.addEventListener('click', (e) => {
  const card = e.target.closest('.event-card');
  if (card) toggleDetail(card);
});
listEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('.event-card');
  if (card) { e.preventDefault(); toggleDetail(card); }
});

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.setAttribute('aria-pressed', 'false'));
    btn.setAttribute('aria-pressed', 'true');
    currentFilter = btn.dataset.filter;
    try { localStorage.setItem('cc-skill-trace-filter', currentFilter); } catch (e) {}
    renderList();
  });
});

// Debounce search input to avoid O(n) filtering on every keystroke (#19)
let _searchTimer;
const searchEl = document.getElementById('searchInput');
searchEl.value = currentSearch;
searchEl.addEventListener('input', e => {
  currentSearch = e.target.value;
  try { localStorage.setItem('cc-skill-trace-search', currentSearch); } catch (err) {}
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(renderList, 200);
});

// Reflect restored filter state on the buttons (#48)
document.querySelectorAll('.filter-btn').forEach(b =>
  b.setAttribute('aria-pressed', String(b.dataset.filter === currentFilter)));

renderList();

// ── Stat cards ────────────────────────────────────────────────────────────
function renderStats() {
  document.getElementById('statTotal').textContent = DATA.stats.total;
  document.getElementById('statAutoRate').textContent = DATA.stats.autoRate + '%';
  document.getElementById('statSkills').textContent = DATA.stats.uniqueSkills;
  document.getElementById('statDays').textContent = DATA.stats.activeDays;
  document.getElementById('generatedAt').textContent = 'Generated: ' +
    new Date(DATA.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// ── Live updates (#228) — only active when served by "report --watch" ────
// The page polls a tiny /api/state endpoint (a signature string) and pulls the
// full payload from /api/data only when that signature actually changed, so an
// idle store costs one small request per interval.
function applyData(next) {
  DATA = next;
  EVENTS = DATA.events;
  TOP_SKILLS = DATA.topSkills;
  BY_DAY = DATA.byDay;
  HEATMAP = DATA.heatmap;
  BRANCHES = DATA.branches;
  eventById = new Map(EVENTS.map(ev => [ev.id, ev]));
  renderStats();
  renderCharts();
  renderHeatmap();
  renderBranches();
  renderList();
}

if (LIVE) {
  const pill = document.getElementById('livePill');
  const pillText = document.getElementById('livePillText');
  let signature = LIVE.signature;
  let flashTimer;
  let polling = false;

  function setPill(state, text) {
    if (!pill) return;
    pill.dataset.state = state;
    if (pillText) pillText.textContent = text;
  }

  function flashUpdated(count) {
    setPill('updated', count + ' events');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => setPill('live', 'live'), 2500);
  }

  async function poll() {
    // Skip while a previous poll is still in flight, and while the tab is
    // hidden — a background tab has nothing to redraw. Mirrors the overlap
    // guard used by "show --follow" (#186).
    if (polling || document.hidden) return;
    polling = true;
    try {
      const state = await fetch('api/state', { cache: 'no-store' }).then(r => r.json());
      if (state.signature !== signature) {
        const payload = await fetch('api/data', { cache: 'no-store' }).then(r => r.json());
        signature = payload.signature;
        applyData(payload.data);
        flashUpdated(payload.data.stats.total);
      } else {
        setPill('live', 'live');
      }
    } catch (err) {
      // The CLI was stopped (Ctrl+C) or the machine went to sleep. Keep the
      // last-rendered data on screen and say so, instead of blanking the page.
      setPill('offline', 'disconnected');
    } finally {
      polling = false;
    }
  }

  setInterval(poll, LIVE.pollMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
}
</script>
</body>
</html>`;
}
