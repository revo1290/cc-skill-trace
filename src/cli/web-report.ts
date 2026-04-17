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

/** Build a standalone HTML file that visualizes skill invocations */
export function buildHtmlReport(events: SkillInvocationEvent[]): string {
  // ── Aggregation ──────────────────────────────────────────────────────────
  const skillCounts: Record<string, { total: number; byUser: number; byClaude: number }> = {};
  for (const ev of events) {
    if (!skillCounts[ev.skillName]) {
      skillCounts[ev.skillName] = { total: 0, byUser: 0, byClaude: 0 };
    }
    skillCounts[ev.skillName].total++;
    if (ev.source === "user") skillCounts[ev.skillName].byUser++;
    else skillCounts[ev.skillName].byClaude++;
  }

  const topSkills = Object.entries(skillCounts)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20);

  const autoRate =
    events.length === 0
      ? 0
      : Math.round((events.filter((e) => e.source === "claude").length / events.length) * 100);

  // Group by day for timeline
  const byDay: Record<string, SkillInvocationEvent[]> = {};
  for (const ev of events) {
    const day = ev.timestamp.slice(0, 10);
    (byDay[day] ??= []).push(ev);
  }

  // ── JSON data embedded in the page ───────────────────────────────────────
  const eventsJson    = safeJson(events);
  const topSkillsJson = safeJson(topSkills);
  const byDayJson     = safeJson(
    Object.entries(byDay).map(([day, evs]) => ({ day, count: evs.length }))
  );

  return /* html */ `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>cc-skill-trace — Skill Invocation Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #f78166;
    --claude: #a78bfa; --user: #38bdf8; --yellow: #fbbf24;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
  .header { padding: 24px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
  .header h1 { font-size: 18px; font-weight: 700; }
  .header .badge { background: var(--accent); color: #0d1117; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 700; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; padding: 24px 32px; }
  .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
  .stat-card .value { font-size: 32px; font-weight: 700; color: var(--yellow); }
  .stat-card .label { color: var(--muted); margin-top: 4px; font-size: 12px; }
  .charts { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; padding: 0 32px 24px; }
  .chart-box { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  .chart-box h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.08em; }
  canvas { max-height: 280px; }
  .timeline { padding: 0 32px 32px; }
  .timeline h2 { font-size: 13px; font-weight: 600; color: var(--muted); margin-bottom: 16px; text-transform: uppercase; letter-spacing: 0.08em; }
  .event-list { display: flex; flex-direction: column; gap: 8px; }
  .event-card { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px 16px; display: grid; grid-template-columns: 140px 160px 80px 1fr; align-items: start; gap: 12px; cursor: pointer; transition: border-color 0.15s; }
  .event-card:hover { border-color: var(--accent); }
  .event-card .time { color: var(--muted); font-size: 11px; }
  .event-card .skill { color: var(--yellow); font-weight: 700; }
  .event-card .source-badge { display: inline-block; border-radius: 3px; padding: 1px 6px; font-size: 11px; font-weight: 600; }
  .source-claude { background: #2e1065; color: var(--claude); }
  .source-user   { background: #0c2a3e; color: var(--user); }
  .event-card .trigger { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail-panel { background: #0d1117; border: 1px solid var(--accent); border-radius: 6px; padding: 16px; margin-top: 4px; display: none; grid-column: 1 / -1; font-size: 12px; line-height: 1.6; }
  .detail-panel .label { color: var(--muted); font-size: 11px; margin-bottom: 4px; }
  .detail-panel .content { color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .search-bar { padding: 0 32px 16px; }
  input[type=text] { width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); padding: 8px 14px; font-family: inherit; font-size: 13px; outline: none; }
  input[type=text]:focus { border-color: var(--accent); }
  .filter-row { padding: 0 32px 16px; display: flex; gap: 10px; flex-wrap: wrap; }
  .filter-btn { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; color: var(--muted); padding: 4px 14px; cursor: pointer; font-family: inherit; font-size: 12px; transition: all 0.15s; }
  .filter-btn.active { border-color: var(--accent); color: var(--accent); }
  @media (max-width: 900px) { .charts { grid-template-columns: 1fr; } .event-card { grid-template-columns: 1fr 1fr; } }
</style>
</head>
<body>

<div class="header">
  <span>🔍</span>
  <h1>cc-skill-trace</h1>
  <span class="badge">Skill Invocation Report</span>
  <span style="margin-left:auto;color:var(--muted);font-size:12px">Generated: ${escapeHtml(new Date().toLocaleString("ja-JP"))}</span>
</div>

<div class="stats">
  <div class="stat-card">
    <div class="value">${events.length}</div>
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

<div class="charts">
  <div class="chart-box">
    <h2>Top Skills by Invocations</h2>
    <canvas id="skillChart"></canvas>
  </div>
  <div class="chart-box">
    <h2>Daily Invocation Activity</h2>
    <canvas id="timelineChart"></canvas>
  </div>
</div>

<div class="filter-row">
  <button class="filter-btn active" data-filter="all">All</button>
  <button class="filter-btn" data-filter="claude">🤖 Claude-triggered</button>
  <button class="filter-btn" data-filter="user">👤 User-triggered</button>
</div>

<div class="search-bar">
  <input type="text" id="searchInput" placeholder="スキル名 or トリガーメッセージで検索…" />
</div>

<div class="timeline">
  <h2>Invocation Timeline <span id="countLabel" style="font-weight:400;color:var(--muted)"></span></h2>
  <div class="event-list" id="eventList"></div>
</div>

<script>
const EVENTS = ${eventsJson};
const TOP_SKILLS = ${topSkillsJson};
const BY_DAY = ${byDayJson};

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
  options: { responsive: true, plugins: { legend: { labels: { color: '#8b949e' } } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } } }
});

const tlCtx = document.getElementById('timelineChart').getContext('2d');
new Chart(tlCtx, {
  type: 'line',
  data: {
    labels: BY_DAY.map(d => d.day),
    datasets: [{ label: 'Invocations', data: BY_DAY.map(d => d.count), borderColor: '#f78166', backgroundColor: '#f7816620', fill: true, tension: 0.3 }]
  },
  options: { responsive: true, plugins: { legend: { labels: { color: '#8b949e' } } }, scales: { x: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } }, y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' } } } }
});

// ── Event list ────────────────────────────────────────────────────────────
let currentFilter = 'all';
let currentSearch = '';
let renderedEvents = [];

function renderList() {
  const filtered = EVENTS.filter(ev => {
    if (currentFilter === 'claude' && ev.source !== 'claude') return false;
    if (currentFilter === 'user'   && ev.source !== 'user')   return false;
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      if (!ev.skillName.toLowerCase().includes(q) && !(ev.triggerMessage || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }).reverse(); // newest first

  renderedEvents = filtered;
  document.getElementById('countLabel').textContent = '(' + filtered.length + ' events)';
  const list = document.getElementById('eventList');
  list.innerHTML = filtered.map((ev, i) => {
    const time = new Date(ev.timestamp).toLocaleString('ja-JP');
    const srcCls = ev.source === 'user' ? 'source-user' : 'source-claude';
    const srcLabel = ev.source === 'user' ? '👤 user' : '🤖 claude';
    const skillDisplay = escapeHtml(ev.skillName) + (ev.skillArgs
      ? \` <span style="color:#8b949e;font-weight:400">\${escapeHtml(ev.skillArgs.slice(0, 30))}</span>\`
      : '');
    const trigger = escapeHtml((ev.triggerMessage || '').slice(0, 100));
    return \`
      <div class="event-card" onclick="toggleDetail(this, \${i})">
        <div class="time">\${escapeHtml(time)}</div>
        <div class="skill">\${skillDisplay}</div>
        <div><span class="source-badge \${srcCls}">\${srcLabel}</span></div>
        <div class="trigger">\${trigger ? '"' + trigger + '"' : '<span style="color:#30363d">—</span>'}</div>
        <div class="detail-panel" id="detail-\${i}"></div>
      </div>\`;
  }).join('');
}

function toggleDetail(card, idx) {
  const ev = renderedEvents[idx];
  const panels = card.querySelectorAll('.detail-panel');
  const panel = panels[panels.length - 1];
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  const gitBranchHtml = ev.gitBranch
    ? \`<div class="label">GIT BRANCH</div><div class="content" style="margin-bottom:12px">\${escapeHtml(ev.gitBranch)}</div>\`
    : '';
  const tokensHtml = (ev.injectedTokens != null)
    ? \`<div class="label">INJECTED TOKENS</div><div class="content">+\${Number(ev.injectedTokens).toLocaleString()} tokens</div>\`
    : '';
  const triggerHtml = ev.triggerMessage
    ? escapeHtml(ev.triggerMessage)
    : '（取得できませんでした。cc-skill-trace scan を実行してください）';
  panel.innerHTML = \`
    <div class="label">SESSION ID</div>
    <div class="content" style="margin-bottom:12px">\${escapeHtml(ev.sessionId || '—')}</div>
    <div class="label">TRIGGER MESSAGE (直前のユーザー発言)</div>
    <div class="content" style="margin-bottom:12px;color:#e6edf3">\${triggerHtml}</div>
    \${gitBranchHtml}
    \${tokensHtml}
  \`;
  panel.style.display = 'block';
}

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderList();
  });
});

document.getElementById('searchInput').addEventListener('input', e => {
  currentSearch = e.target.value;
  renderList();
});

renderList();
</script>
</body>
</html>`;
}
