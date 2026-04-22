import chalk from "chalk";
import type { SkillInvocationEvent } from "../core/types.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function W(): number {
  return Math.min(process.stdout.columns ?? 80, 100);
}

/** Strip ANSI escape sequences to get visual string length. */
function vlen(s: string): number {
  // Remove ANSI codes then count: emoji = 2 cols, others = 1
  const plain = s.replace(/\x1B\[[0-9;]*m/g, "");
  let len = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0) ?? 0;
    // Wide chars: CJK, emoji ranges
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0x2E80 && cp <= 0x303E) ||
      (cp >= 0x3040 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE10 && cp <= 0xFE1F) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||
      (cp >= 0x1F300 && cp <= 0x1FAFF) // emoji
    ) {
      len += 2;
    } else {
      len += 1;
    }
  }
  return len;
}

function padRight(s: string, targetVisualLen: number): string {
  const spaces = Math.max(0, targetVisualLen - vlen(s));
  return s + " ".repeat(spaces);
}

function bar(ratio: number, width: number, color: (s: string) => string): string {
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return color("█".repeat(filled)) + chalk.gray("░".repeat(width - filled));
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

// ─── Section renderers ───────────────────────────────────────────────────────

function hr(char = "─"): string {
  return chalk.gray(char.repeat(W()));
}

function section(title: string): string {
  return chalk.bold.white(title);
}

function row(label: string, value: string): string {
  return chalk.gray("  ") + padRight(label, 20) + value;
}

// ─── Stats bar chart ─────────────────────────────────────────────────────────

export interface SkillStat {
  name: string;
  total: number;
  auto: number;
  byUser: number;
}

export function buildStats(events: SkillInvocationEvent[]): SkillStat[] {
  const map: Record<string, SkillStat> = {};
  for (const ev of events) {
    if (!map[ev.skillName]) map[ev.skillName] = { name: ev.skillName, total: 0, auto: 0, byUser: 0 };
    map[ev.skillName].total++;
    if (ev.source === "claude") map[ev.skillName].auto++;
    else map[ev.skillName].byUser++;
  }
  return Object.values(map).sort((a, b) => b.total - a.total);
}

// ─── Stats view ──────────────────────────────────────────────────────────────

export function renderStats(events: SkillInvocationEvent[]): string {
  const lines: string[] = [];

  lines.push(hr("═"));
  lines.push(chalk.bold.white("  📈 cc-skill-trace ─ Stats"));
  lines.push(hr("─"));

  if (events.length === 0) {
    lines.push(chalk.gray("\n  No events yet.\n"));
    lines.push(hr("═"));
    return lines.join("\n");
  }

  // ── Per-day breakdown (last 14 days) ──
  const dayMap: Record<string, { total: number; auto: number }> = {};
  for (const ev of events) {
    const day = ev.timestamp.slice(0, 10);
    if (!dayMap[day]) dayMap[day] = { total: 0, auto: 0 };
    dayMap[day].total++;
    if (ev.source === "claude") dayMap[day].auto++;
  }
  const days = Object.keys(dayMap).sort().slice(-14);
  const maxDay = Math.max(...days.map(d => dayMap[d]!.total), 1);
  const dayBarW = 24;

  lines.push("");
  lines.push(section("  📅 Daily activity") + chalk.gray("  (last 14 days)"));
  lines.push("");
  for (const day of days) {
    const d = dayMap[day]!;
    const autoB = "█".repeat(Math.round((d.auto / maxDay) * dayBarW));
    const userFill = Math.min(dayBarW - autoB.length, Math.round(((d.total - d.auto) / maxDay) * dayBarW));
    const userB = "█".repeat(userFill);
    const emptyB = "░".repeat(Math.max(0, dayBarW - autoB.length - userB.length));
    const label = padRight(chalk.gray(day), 12);
    lines.push(
      "  " + label + "  " +
      chalk.magenta(autoB) + chalk.cyan(userB) + chalk.gray(emptyB) +
      chalk.bold.white(`  ${d.total}x`)
    );
  }

  // ── Top sessions ──
  const sessMap: Record<string, number> = {};
  for (const ev of events) {
    sessMap[ev.sessionId] = (sessMap[ev.sessionId] ?? 0) + 1;
  }
  const topSessions = Object.entries(sessMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  lines.push("");
  lines.push(hr("─"));
  lines.push("");
  lines.push(section("  🗂  Top sessions") + chalk.gray("  (by invocations)"));
  lines.push("");
  const maxSess = topSessions[0]?.[1] ?? 1;
  const sessBarW = 20;
  for (const [sessId, count] of topSessions) {
    const filled = Math.round((count / maxSess) * sessBarW);
    const b = chalk.yellow("█".repeat(filled)) + chalk.gray("░".repeat(sessBarW - filled));
    const label = padRight(chalk.gray(sessId.slice(0, 20)), 22);
    lines.push("  " + label + "  " + b + chalk.bold.white(`  ${count}x`));
  }

  lines.push("");
  lines.push(hr("═"));
  return lines.join("\n");
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export function renderDashboard(events: SkillInvocationEvent[]): string {
  const lines: string[] = [];

  // ── header ──
  lines.push(hr("═"));
  lines.push(
    chalk.bold.white("  🔍 cc-skill-trace ") +
    chalk.gray("─ Skill Invocation Debugger")
  );
  lines.push(hr("─"));

  if (events.length === 0) {
    lines.push("");
    lines.push(chalk.gray("  No events yet."));
    lines.push(chalk.gray("  1. Run: cc-skill-trace install"));
    lines.push(chalk.gray("  2. Restart Claude Code"));
    lines.push(chalk.gray("  3. Use any skill → events appear here"));
    lines.push("");
    lines.push(chalk.gray("  Or backfill past sessions: cc-skill-trace show --scan"));
    lines.push("");
    lines.push(hr("═"));
    return lines.join("\n");
  }

  // ── summary stats ──
  const total   = events.length;
  const autoCnt = events.filter(e => e.source === "claude").length;
  const userCnt = total - autoCnt;
  const autoRate = Math.round((autoCnt / total) * 100);
  const uniqueSkills = new Set(events.map(e => e.skillName)).size;

  lines.push("");
  lines.push(
    chalk.gray("  ") +
    chalk.bold.white(String(total).padStart(4)) + chalk.gray(" invocations   ") +
    chalk.magenta(String(autoCnt).padStart(3)) + chalk.gray(" 🤖 auto   ") +
    chalk.cyan(String(userCnt).padStart(3)) + chalk.gray(" 👤 user   ") +
    chalk.yellow(String(uniqueSkills).padStart(3)) + chalk.gray(" unique skills")
  );
  lines.push("");

  // auto-trigger rate bar
  const rateBarW = 30;
  const rateColor = autoRate >= 70 ? chalk.magenta : chalk.cyan;
  lines.push(
    chalk.gray("  🤖 Auto-trigger  ") +
    bar(autoRate / 100, rateBarW, rateColor) +
    chalk.bold.white(`  ${autoRate}%`)
  );
  lines.push("");
  lines.push(hr("─"));

  // ── skill bar chart ──
  const stats = buildStats(events);
  const maxTotal = stats[0]?.total ?? 1;
  const barW = 24;
  const nameW = Math.min(22, Math.max(8, ...stats.map(s => s.name.length)) + 1);

  lines.push("");
  lines.push(section("  📊 Skills"));
  lines.push("");

  for (const s of stats.slice(0, 8)) {
    const autoB  = "█".repeat(Math.round((s.auto   / maxTotal) * barW));
    const userFill = Math.min(barW - autoB.length, Math.round((s.byUser / maxTotal) * barW));
    const userB  = "█".repeat(userFill);
    const emptyB = "░".repeat(Math.max(0, barW - autoB.length - userB.length));
    const nameLabel = padRight(chalk.bold.yellow(s.name), nameW + 9 /* ansi overhead approx */);
    lines.push(
      "  " + nameLabel + "  " +
      chalk.magenta(autoB) + chalk.cyan(userB) + chalk.gray(emptyB) +
      chalk.bold.white(`  ${s.total}x`) +
      chalk.gray(`  ${s.auto}auto`) +
      chalk.gray(` · `) +
      chalk.gray(`${s.byUser}user`)
    );
  }

  lines.push("");
  lines.push(hr("─"));

  // ── recent timeline ──
  const recent = [...events]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 12);

  lines.push("");
  lines.push(section("  🕐 Recent invocations") + chalk.gray("  (newest first)"));
  lines.push("");

  for (const ev of recent) {
    const dot  = ev.source === "claude" ? chalk.magenta("●") : chalk.cyan("●");
    const time = chalk.gray(fmtTime(ev.timestamp));
    const name = padRight(chalk.bold.yellow(ev.skillName), nameW + 9);
    const src  = ev.source === "claude"
      ? chalk.magenta("🤖 auto")
      : chalk.cyan("👤 user");

    const maxTriggerW = Math.max(10, W() - nameW - 36);
    const trigger = ev.triggerMessage
      ? chalk.italic.gray(`"${ev.triggerMessage.replace(/\n/g, " ").slice(0, maxTriggerW)}"`)
      : chalk.gray("(no trigger context)");

    lines.push(`  ${dot} ${time}  ${name}  ${src}  ${trigger}`);
  }

  lines.push("");
  lines.push(hr("─"));
  lines.push(chalk.gray("  ") + chalk.underline.gray("cc-skill-trace report") + chalk.gray("  → interactive browser dashboard"));
  lines.push(hr("═"));

  return lines.join("\n");
}

// ─── Compact list ─────────────────────────────────────────────────────────────

export function renderCompact(events: SkillInvocationEvent[]): string {
  const lines: string[] = [];
  lines.push(chalk.gray("time           skill                 src      trigger"));
  lines.push(chalk.gray("─".repeat(78)));
  for (const ev of [...events].reverse()) {
    const t = fmtTime(ev.timestamp);
    const n = padRight(chalk.bold.yellow(ev.skillName), 22 + 9);
    const s = ev.source === "claude" ? chalk.magenta("🤖 auto") : chalk.cyan("👤 user");
    const trigger = chalk.gray((ev.triggerMessage ?? "").replace(/\n/g, " ").slice(0, 35));
    lines.push(`${chalk.gray(t)}  ${n}  ${s}  ${trigger}`);
  }
  return lines.join("\n");
}
