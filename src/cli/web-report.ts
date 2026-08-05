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

/** Options for {@link buildHtmlReport}. */
export interface HtmlReportOptions {
  /** Initial color theme (#150). "auto" follows prefers-color-scheme. */
  theme?: "dark" | "light" | "auto";
  /** Mask trigger messages before embedding them (#108). */
  redactTriggers?: boolean;
}

/** Build a standalone HTML file that visualizes skill invocations */
export function buildHtmlReport(
  events: SkillInvocationEvent[],
  opts: HtmlReportOptions = {}
): string {
  const theme = opts.theme ?? "auto";

  // ── Privacy: redact trigger messages before anything is embedded (#108) ──
  const sourceEvents: SkillInvocationEvent[] = opts.redactTriggers
    ? events.map((ev) => (ev.triggerMessage ? { ...ev, triggerMessage: "[redacted]" } : ev))
    : events;

  // ── Aggregation ──────────────────────────────────────────────────────────
  const skillCounts: Record<string, { total: number; byUser: number; byClaude: number }> = {};
  for (const ev of sourceEvents) {
    const counts = skillCounts[ev.skillName] ?? { total: 0, byUser: 0, byClaude: 0 };
    skillCounts[ev.skillName] = counts;
    counts.total++;
    if (ev.source === "user") counts.byUser++;
    else counts.byClaude++;
  }

  const topSkills = Object.entries(skillCounts)
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

  // Skill × hour-of-day heatmap for the top skills (#46)
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
  const topBranches = Object.entries(byBranch)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // ── JSON data embedded in the page ───────────────────────────────────────
  const eventsJson = safeJson(sourceEvents);
  const topSkillsJson = safeJson(topSkills);
  const byDayJson = safeJson(
    Object.entries(byDay)
      .sort()
      .map(([day, count]) => ({ day, count }))
  );
  const heatmapJson = safeJson({ skills: heatSkills, rows: heatSkills.map((s) => heatmap[s]) });
  const branchesJson = safeJson(topBranches);

  return /* html */ `<!DOCTYPE html>
<html lang="en" data-theme="${theme === "auto" ? "" : theme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none';">
<title>cc-skill-trace — Skill Invocation Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.8/dist/chart.umd.min.js"
  integrity="sha384-T/4KgSWuZEPozpPz7rnnp/5lDSnpY1VPJCojf1S81uTHS1E38qgLfMgVsAeRCWc4"
  crossorigin="anonymous"
  onerror="document.getElementById('charts-section').innerHTML='<p class=\\'cdn-error\\'>⚠ Charts unavailable — Chart.js could not be loaded (no internet connection?). The event table below is still fully functional.</p>'"></script>
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
    <span>Generated: ${escapeHtml(new Date().toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}</span>
    <button id="themeToggle" type="button" aria-label="Toggle color theme">◐ theme</button>
  </span>
</div>

<div class="stats" role="group" aria-label="Summary statistics">
  <div class="stat-card">
    <div class="value">${sourceEvents.length}</div>
    <div class="label">Total Invocations</div>
  </div>
  <div class="stat-card">
    <div class="value" style="color:var(--claude)">${autoRate}%</div>
    <div class="label">Auto-triggered by Claude</div>
  </div>
  <div class="stat-card">
    <div class="value" style="color:var(--yellow)">${Object.keys(skillCounts).length}</div>
    <div class="label">Unique Skills Used</div>
  </div>
  <div class="stat-card">
    <div class="value" style="color:var(--user)">${Object.keys(byDay).length}</div>
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
const EVENTS = ${eventsJson};
const TOP_SKILLS = ${topSkillsJson};
const BY_DAY = ${byDayJson};
const HEATMAP = ${heatmapJson};
const BRANCHES = ${branchesJson};
const INITIAL_THEME = ${safeJson(theme)};

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
if (typeof Chart !== 'undefined') {
  const skillCtx = document.getElementById('skillChart').getContext('2d');
  new Chart(skillCtx, {
    type: 'bar',
    data: {
      labels: TOP_SKILLS.map(([name]) => name),
      datasets: [
        { label: 'Claude', data: TOP_SKILLS.map(([,d]) => d.byClaude), backgroundColor: '#a78bfa80', borderColor: '#a78bfa', borderWidth: 1 },
        { label: 'User',   data: TOP_SKILLS.map(([,d]) => d.byUser),   backgroundColor: '#38bdf880', borderColor: '#38bdf8', borderWidth: 1 },
      ]
    },
    options: { responsive: true, plugins: { legend: { labels: { color: '#8b949e' } } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d40' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d40' } } } }
  });

  const tlCtx = document.getElementById('timelineChart').getContext('2d');
  new Chart(tlCtx, {
    type: 'line',
    data: {
      labels: BY_DAY.map(d => d.day),
      datasets: [{ label: 'Invocations', data: BY_DAY.map(d => d.count), borderColor: '#f78166', backgroundColor: '#f7816620', fill: true, tension: 0.3 }]
    },
    options: { responsive: true, plugins: { legend: { labels: { color: '#8b949e' } } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d40' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d40' } } } }
  });
}

// ── Skill × hour heatmap (#46) — pure CSS grid, no chart library ─────────
(function renderHeatmap() {
  const el = document.getElementById('heatmap');
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
})();

// ── Git-branch bars (#101) ────────────────────────────────────────────────
(function renderBranches() {
  const el = document.getElementById('branches');
  if (!BRANCHES.length) { el.innerHTML = '<p style="color:var(--muted);font-size:12px">No branch data — events captured by the hook include the git branch automatically.</p>'; return; }
  const max = BRANCHES[0][1];
  el.innerHTML = BRANCHES.map(([name, count]) =>
    '<div class="branch-row"><span class="bname" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>' +
    '<span class="bbar" style="width:' + Math.max(2, Math.round((count / max) * 60)) + '%"></span>' +
    '<span class="bcount">' + count + 'x</span></div>'
  ).join('');
})();

// ── Event list with pagination and debounced search (#19) ────────────────
const PAGE_SIZE = 100;
let currentFilter = 'all';
let currentSearch = '';
let currentPage = 0;
let filteredEvents = [];
// Keyed by event ID so detail panels remain correct after filter changes
const eventById = new Map(EVENTS.map(ev => [ev.id, ev]));

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
</script>
</body>
</html>`;
}
