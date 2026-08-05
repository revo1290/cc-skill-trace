import chalk from "chalk";
import {
  analyzeAutoTriggers,
  computeStreaks,
  diffPeriods,
  estimateCost,
  groupByCwd,
  hourHistogram,
} from "../core/analyze.js";
import type { Period } from "../core/analyze.js";
import type { SkillInvocationEvent } from "../core/types.js";

// ─── Render configuration (#143, #195) ───────────────────────────────────────

interface RenderConfig {
  aliases: Record<string, string>;
  maxWidth: number;
}

const renderConfig: RenderConfig = { aliases: {}, maxWidth: 100 };

/** Configure global render options: skill aliases (#143) and width cap (#195). */
export function configureRender(opts: {
  aliases?: Record<string, string>;
  maxWidth?: number;
}): void {
  if (opts.aliases) renderConfig.aliases = opts.aliases;
  if (opts.maxWidth && opts.maxWidth > 20) renderConfig.maxWidth = opts.maxWidth;
}

/** Display name for a skill, honoring configured aliases (#143). */
export function displayName(skillName: string): string {
  return renderConfig.aliases[skillName] ?? skillName;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function W(): number {
  return Math.min(process.stdout.columns ?? 80, renderConfig.maxWidth);
}

// Reuse a single Intl.Segmenter instance — it is stateless and safe to share.
const _segmenter = new Intl.Segmenter();

/**
 * Match ANSI escape sequences so they can be stripped before measuring width.
 *
 * Covers, in order:
 *  - CSI sequences (`\x1B[…<final>`) — includes SGR colors (`\x1B[32m`) as well
 *    as cursor moves / screen clears (`\x1B[2J`, `\x1B[1;1H`) that a SGR-only
 *    regex would miss.
 *  - OSC sequences (`\x1B]…`) terminated by BEL (`\x07`) or ST (`\x1B\\`) —
 *    e.g. OSC 8 hyperlinks and OSC 0 window titles.
 *  - Other two-byte escapes (`\x1B` + a single Fe byte).
 */
// Order matters: OSC (`\x1B]…`) and CSI (`\x1B[…`) are matched before the
// generic two-byte-escape branch, whose char class also contains `]`/`[`.
const ANSI_RE = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

/**
 * Visual (terminal column) length of a string.
 *
 * Uses Intl.Segmenter so that each ZWJ sequence (👨‍👩‍👧), variation-selector
 * sequence (©️, 👍🏽), and keycap sequence (1️⃣) is treated as one grapheme
 * cluster and counted as 2 columns rather than N×2 columns.
 * ANSI escape sequences are stripped before measuring.
 */
export function vlen(s: string): number {
  const plain = s.replace(ANSI_RE, "");
  let len = 0;
  for (const { segment } of _segmenter.segment(plain)) {
    const cp = segment.codePointAt(0) ?? 0;
    // Lone ZWJ or variation selectors that start a segment are zero-width
    if (cp === 0x200d || cp === 0xfe0f || cp === 0xfe0e) continue;
    // Keycap sequences (1️⃣ #️⃣): base char is ASCII but renders 2 columns wide
    if (segment.includes("\u20E3")) {
      len += 2;
      continue;
    }
    // Text→emoji via VS16 (©️ ™️): base char not in emoji range but renders 2 wide
    if (segment.includes("\uFE0F")) {
      len += 2;
      continue;
    }
    // Wide chars: CJK ideographs, Hangul, fullwidth forms, emoji block
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3040 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe1f) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
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
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Source glyph: how the event was recorded — ⚡ hook (live) vs ≡ scan (backfill) (#148). */
function viaGlyph(ev: SkillInvocationEvent): string {
  if (ev.recordedVia === "hook") return chalk.green("⚡");
  if (ev.recordedVia === "scan") return chalk.blue("≡");
  return chalk.gray("·");
}

// ─── Section renderers ───────────────────────────────────────────────────────

function hr(char = "─"): string {
  return chalk.gray(char.repeat(W()));
}

function section(title: string): string {
  return chalk.bold.white(title);
}

/** Actionable hint shown whenever a view has no events to display (#96). */
export function emptyHint(): string {
  return [
    chalk.gray("  No events yet."),
    chalk.gray("  1. Run: cc-skill-trace install"),
    chalk.gray("  2. Restart Claude Code"),
    chalk.gray("  3. Use any skill → events appear here"),
    "",
    chalk.gray("  Or backfill past sessions: cc-skill-trace scan"),
  ].join("\n");
}

// ─── Stats bar chart ─────────────────────────────────────────────────────────

export interface SkillStat {
  name: string;
  total: number;
  auto: number;
  byUser: number;
  /** Percentage of invocations auto-triggered by Claude (0–100). */
  autoRate: number;
}

export function buildStats(events: SkillInvocationEvent[]): SkillStat[] {
  const map: Record<string, SkillStat> = {};
  for (const ev of events) {
    const stat = map[ev.skillName] ?? {
      name: ev.skillName,
      total: 0,
      auto: 0,
      byUser: 0,
      autoRate: 0,
    };
    map[ev.skillName] = stat;
    stat.total++;
    if (ev.source === "claude") stat.auto++;
    else stat.byUser++;
  }
  const stats = Object.values(map);
  for (const s of stats) s.autoRate = s.total === 0 ? 0 : Math.round((s.auto / s.total) * 100);
  return stats.sort((a, b) => b.total - a.total);
}

/** Sort skill stats for list-skills --sort (#103). */
export function sortStats(stats: SkillStat[], by: "count" | "name" | "auto"): SkillStat[] {
  const copy = [...stats];
  if (by === "name") return copy.sort((a, b) => a.name.localeCompare(b.name));
  if (by === "auto") return copy.sort((a, b) => b.autoRate - a.autoRate || b.total - a.total);
  return copy.sort((a, b) => b.total - a.total);
}

// ─── Stats view ──────────────────────────────────────────────────────────────

/** Options for {@link renderStats}. */
export interface RenderStatsOptions {
  /** Show at most this many rows per section (#191). */
  limit?: number;
  /** Daily-activity window in days (#102, default 14). */
  days?: number;
}

export function renderStats(events: SkillInvocationEvent[], opts: RenderStatsOptions = {}): string {
  const topN = opts.limit ?? 5;
  const dayWindow = opts.days ?? 14;
  const lines: string[] = [];

  lines.push(hr("═"));
  lines.push(chalk.bold.white("  📈 cc-skill-trace ─ Stats"));
  lines.push(hr("─"));

  if (events.length === 0) {
    lines.push("");
    lines.push(emptyHint());
    lines.push("");
    lines.push(hr("═"));
    return lines.join("\n");
  }

  // ── Per-day breakdown ──
  const dayMap: Record<string, { total: number; auto: number }> = {};
  for (const ev of events) {
    const day = ev.timestamp.slice(0, 10);
    const stat = dayMap[day] ?? { total: 0, auto: 0 };
    dayMap[day] = stat;
    stat.total++;
    if (ev.source === "claude") stat.auto++;
  }
  const days = Object.keys(dayMap).sort().slice(-dayWindow);
  const maxDay = Math.max(...days.map((d) => dayMap[d]?.total), 1);
  const dayBarW = 24;

  lines.push("");
  lines.push(section("  📅 Daily activity") + chalk.gray(`  (last ${dayWindow} days)`));
  lines.push("");
  for (const day of days) {
    // biome-ignore lint/style/noNonNullAssertion: `days` is Object.keys(dayMap) (sorted/sliced), so every `day` here is a key that exists in dayMap.
    const d = dayMap[day]!;
    const autoB = "█".repeat(Math.round((d.auto / maxDay) * dayBarW));
    const userFill = Math.min(
      dayBarW - autoB.length,
      Math.round(((d.total - d.auto) / maxDay) * dayBarW)
    );
    const userB = "█".repeat(userFill);
    const emptyB = "░".repeat(Math.max(0, dayBarW - autoB.length - userB.length));
    const label = padRight(chalk.gray(day), 12);
    lines.push(
      `  ${label}  ${chalk.magenta(autoB)}${chalk.cyan(userB)}${chalk.gray(emptyB)}${chalk.bold.white(`  ${d.total}x`)}`
    );
  }

  // ── Streak (#166) ──
  const streak = computeStreaks(events);
  lines.push("");
  lines.push(
    chalk.gray("  🔥 Streak  ") +
      chalk.bold.white(`${streak.current} day${streak.current === 1 ? "" : "s"}`) +
      chalk.gray(`  (longest: ${streak.longest})`)
  );

  // ── Hour-of-day pattern (#160) ──
  const hours = hourHistogram(events);
  const maxHour = Math.max(...hours, 1);
  const blocks = " ▁▂▃▄▅▆▇█";
  const spark = hours
    .map((h) => {
      const idx = h === 0 ? 0 : Math.max(1, Math.round((h / maxHour) * 8));
      return blocks[idx];
    })
    .join("");
  const peakHour = hours.indexOf(Math.max(...hours));
  lines.push("");
  lines.push(hr("─"));
  lines.push("");
  lines.push(section("  🕐 Hour of day") + chalk.gray("  (local time)"));
  lines.push("");
  lines.push(
    `  ${chalk.gray("0h ")}${chalk.cyan(spark)}${chalk.gray(" 23h")}   ${chalk.gray("peak:")} ${chalk.bold.white(`${peakHour}:00`)}`
  );

  // ── Top sessions ──
  const sessMap: Record<string, number> = {};
  for (const ev of events) {
    sessMap[ev.sessionId] = (sessMap[ev.sessionId] ?? 0) + 1;
  }
  const topSessions = Object.entries(sessMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

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
    lines.push(`  ${label}  ${b}${chalk.bold.white(`  ${count}x`)}`);
  }

  // ── Top working directories (#135) ──
  const cwds = groupByCwd(events)
    .filter((c) => c.cwd !== "(unknown)")
    .slice(0, topN);
  if (cwds.length > 0) {
    lines.push("");
    lines.push(hr("─"));
    lines.push("");
    lines.push(section("  📁 Top directories"));
    lines.push("");
    const maxCwd = cwds[0]?.total ?? 1;
    for (const c of cwds) {
      const filled = Math.round((c.total / maxCwd) * sessBarW);
      const b = chalk.blue("█".repeat(filled)) + chalk.gray("░".repeat(sessBarW - filled));
      const short = c.cwd.length > 30 ? `…${c.cwd.slice(-29)}` : c.cwd;
      lines.push(`  ${padRight(chalk.gray(short), 32)}  ${b}${chalk.bold.white(`  ${c.total}x`)}`);
    }
  }

  lines.push("");
  lines.push(hr("═"));
  return lines.join("\n");
}

// ─── Cost estimate view (#49) ────────────────────────────────────────────────

export function renderCost(events: SkillInvocationEvent[], model = "sonnet"): string {
  const cost = estimateCost(events, model);
  const lines: string[] = [];
  lines.push(hr("═"));
  lines.push(chalk.bold.white("  💰 cc-skill-trace ─ Injected-token cost estimate"));
  lines.push(hr("─"));
  lines.push("");
  if (cost.measuredEvents === 0) {
    lines.push(chalk.gray("  No events with measured injectedTokens."));
    lines.push(
      chalk.gray("  Run: cc-skill-trace scan   (token counts come from session-log backfill)")
    );
    lines.push("");
    lines.push(hr("═"));
    return lines.join("\n");
  }
  lines.push(
    chalk.gray("  model ") +
      chalk.bold.white(cost.model) +
      chalk.gray(`  ($${cost.pricePerMTok}/MTok input)   events measured: `) +
      chalk.bold.white(String(cost.measuredEvents))
  );
  lines.push("");
  for (const row of cost.perSkill.slice(0, 10)) {
    lines.push(
      `  ${padRight(chalk.bold.yellow(displayName(row.skillName)), 30)}` +
        `${chalk.white(row.tokens.toLocaleString().padStart(10))} ${chalk.gray("tok")}` +
        `  ${chalk.green(`$${row.usd.toFixed(4)}`)}`
    );
  }
  lines.push("");
  lines.push(
    `  ${chalk.gray("total")}  ${chalk.bold.white(cost.totalInjectedTokens.toLocaleString())} ${chalk.gray("tokens")}` +
      `  ≈ ${chalk.bold.green(`$${cost.estimatedUSD.toFixed(4)}`)}`
  );
  lines.push(
    chalk.gray(
      "  Estimate covers skill-content injection only (input tokens), not full conversation cost."
    )
  );
  lines.push("");
  lines.push(hr("═"));
  return lines.join("\n");
}

// ─── Period diff view (#44) ──────────────────────────────────────────────────

export function renderDiff(
  events: SkillInvocationEvent[],
  periodA: Period,
  periodB: Period,
  labels: { a: string; b: string }
): string {
  const rows = diffPeriods(events, periodA, periodB);
  const lines: string[] = [];
  lines.push(hr("═"));
  lines.push(chalk.bold.white("  ⇄ cc-skill-trace ─ Period comparison"));
  lines.push(hr("─"));
  lines.push("");
  lines.push(chalk.gray(`  A: ${labels.a}    B: ${labels.b}`));
  lines.push("");
  if (rows.length === 0) {
    lines.push(chalk.gray("  No events in either period."));
    lines.push("");
    lines.push(hr("═"));
    return lines.join("\n");
  }
  lines.push(
    chalk.gray(`  ${padRight("skill", 26)}${"A".padStart(6)}${"B".padStart(6)}   Δ      auto A→B`)
  );
  lines.push(chalk.gray(`  ${"─".repeat(60)}`));
  for (const r of rows.slice(0, 15)) {
    const deltaStr =
      r.delta > 0
        ? chalk.green(`+${r.delta}`)
        : r.delta < 0
          ? chalk.red(String(r.delta))
          : chalk.gray("±0");
    lines.push(
      `  ${padRight(chalk.bold.yellow(displayName(r.skillName)), 26)}` +
        chalk.white(String(r.countA).padStart(6)) +
        chalk.white(String(r.countB).padStart(6)) +
        `   ${padRight(deltaStr, 5)}` +
        chalk.gray(`  ${r.autoRateA}% → ${r.autoRateB}%`)
    );
  }
  lines.push("");
  lines.push(hr("═"));
  return lines.join("\n");
}

// ─── Diagnose view (#41) ─────────────────────────────────────────────────────

export function renderDiagnose(events: SkillInvocationEvent[]): string {
  const findings = analyzeAutoTriggers(events);
  const lines: string[] = [];
  lines.push(hr("═"));
  lines.push(chalk.bold.white("  🩺 cc-skill-trace ─ Auto-trigger diagnosis"));
  lines.push(hr("─"));
  lines.push("");
  if (events.length === 0) {
    lines.push(emptyHint());
    lines.push("");
    lines.push(hr("═"));
    return lines.join("\n");
  }
  const flagged = findings.filter((f) => f.severity !== "low");
  if (flagged.length === 0) {
    lines.push(chalk.green("  ✓ No over-triggering skills detected."));
    lines.push(
      chalk.gray(`  Analyzed ${findings.length} skills across ${events.length} invocations.`)
    );
  }
  for (const f of flagged) {
    const sev = f.severity === "high" ? chalk.red("● HIGH  ") : chalk.yellow("● MEDIUM");
    lines.push(
      `  ${sev}  ${chalk.bold.yellow(displayName(f.skillName))}  ${chalk.gray(`${f.auto}/${f.total} auto (${f.autoRate}%)`)}`
    );
    for (const s of f.suggestions) {
      lines.push(chalk.gray(`          → ${s}`));
    }
    lines.push("");
  }
  lines.push(hr("═"));
  return lines.join("\n");
}

// ─── Session-grouped view (#121) ─────────────────────────────────────────────

export function renderGroupBySession(events: SkillInvocationEvent[]): string {
  const lines: string[] = [];
  lines.push(hr("═"));
  lines.push(chalk.bold.white("  🗂  cc-skill-trace ─ Events by session"));
  lines.push(hr("─"));
  if (events.length === 0) {
    lines.push("");
    lines.push(emptyHint());
    lines.push("");
    lines.push(hr("═"));
    return lines.join("\n");
  }
  const bySession = new Map<string, SkillInvocationEvent[]>();
  for (const ev of events) {
    const list = bySession.get(ev.sessionId) ?? [];
    list.push(ev);
    bySession.set(ev.sessionId, list);
  }
  const sessions = [...bySession.entries()].sort((a, b) =>
    (b[1].at(-1)?.timestamp ?? "").localeCompare(a[1].at(-1)?.timestamp ?? "")
  );
  for (const [sessionId, evs] of sessions) {
    const day = evs[0]?.timestamp.slice(0, 10) ?? "";
    lines.push("");
    lines.push(
      `  ${chalk.bold.white(sessionId.slice(0, 28))}  ${chalk.gray(`${day} · ${evs.length} invocation${evs.length === 1 ? "" : "s"}`)}`
    );
    for (const ev of evs) {
      const src = ev.source === "claude" ? chalk.magenta("auto") : chalk.cyan("user");
      lines.push(
        `    ${viaGlyph(ev)} ${chalk.gray(fmtTime(ev.timestamp))}  ${padRight(chalk.bold.yellow(displayName(ev.skillName)), 30)} ${src}`
      );
    }
  }
  lines.push("");
  lines.push(hr("═"));
  return lines.join("\n");
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

/** Options for {@link renderDashboard} (#134). */
export interface RenderDashboardOptions {
  /** 1-based page of the recent-invocations list (#134). */
  page?: number;
  /** Rows per page in the recent-invocations list (default 12) (#134). */
  perPage?: number;
}

export function renderDashboard(
  events: SkillInvocationEvent[],
  opts: RenderDashboardOptions = {}
): string {
  const lines: string[] = [];

  // ── header ──
  lines.push(hr("═"));
  lines.push(chalk.bold.white("  🔍 cc-skill-trace ") + chalk.gray("─ Skill Invocation Debugger"));
  lines.push(hr("─"));

  if (events.length === 0) {
    lines.push("");
    lines.push(emptyHint());
    lines.push("");
    lines.push(hr("═"));
    return lines.join("\n");
  }

  // ── summary stats ──
  const total = events.length;
  const autoCnt = events.filter((e) => e.source === "claude").length;
  const userCnt = total - autoCnt;
  const autoRate = Math.round((autoCnt / total) * 100);
  const uniqueSkills = new Set(events.map((e) => e.skillName)).size;

  lines.push("");
  lines.push(
    chalk.gray("  ") +
      chalk.bold.white(String(total).padStart(4)) +
      chalk.gray(" invocations   ") +
      chalk.magenta(String(autoCnt).padStart(3)) +
      chalk.gray(" 🤖 auto   ") +
      chalk.cyan(String(userCnt).padStart(3)) +
      chalk.gray(" 👤 user   ") +
      chalk.yellow(String(uniqueSkills).padStart(3)) +
      chalk.gray(" unique skills")
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
  const nameW = Math.min(22, Math.max(8, ...stats.map((s) => displayName(s.name).length)) + 1);

  lines.push("");
  lines.push(section("  📊 Skills"));
  lines.push("");

  for (const s of stats.slice(0, 8)) {
    const autoB = "█".repeat(Math.round((s.auto / maxTotal) * barW));
    const userFill = Math.min(barW - autoB.length, Math.round((s.byUser / maxTotal) * barW));
    const userB = "█".repeat(userFill);
    const emptyB = "░".repeat(Math.max(0, barW - autoB.length - userB.length));
    const nameLabel = padRight(
      chalk.bold.yellow(displayName(s.name)),
      nameW + 9 /* ansi overhead approx */
    );
    lines.push(
      `  ${nameLabel}  ` +
        chalk.magenta(autoB) +
        chalk.cyan(userB) +
        chalk.gray(emptyB) +
        chalk.bold.white(`  ${s.total}x`) +
        chalk.gray(`  ${s.auto}auto`) +
        chalk.gray(" · ") +
        chalk.gray(`${s.byUser}user`)
    );
  }

  lines.push("");
  lines.push(hr("─"));

  // ── recent timeline (paginated, #134) ──
  const perPage = Math.max(1, opts.perPage ?? 12);
  const page = Math.max(1, opts.page ?? 1);
  const sorted = [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const clampedPage = Math.min(page, totalPages);
  const recent = sorted.slice((clampedPage - 1) * perPage, clampedPage * perPage);

  lines.push("");
  const pageInfo =
    totalPages > 1
      ? chalk.gray(`  (page ${clampedPage}/${totalPages} — newest first)`)
      : chalk.gray("  (newest first)");
  lines.push(section("  🕐 Recent invocations") + pageInfo);
  lines.push("");

  for (const ev of recent) {
    const dot = ev.source === "claude" ? chalk.magenta("●") : chalk.cyan("●");
    const time = chalk.gray(fmtTime(ev.timestamp));
    const name = padRight(chalk.bold.yellow(displayName(ev.skillName)), nameW + 9);
    const src = ev.source === "claude" ? chalk.magenta("🤖 auto") : chalk.cyan("👤 user");

    const maxTriggerW = Math.max(10, W() - nameW - 38);
    const trigger = ev.triggerMessage
      ? chalk.italic.gray(`"${ev.triggerMessage.replace(/\n/g, " ").slice(0, maxTriggerW)}"`)
      : chalk.gray("(no trigger context)");

    const meta: string[] = [];
    if (ev.cwd) meta.push(chalk.gray(`  cwd: ${ev.cwd}`));
    if (ev.injectedTokens) meta.push(chalk.gray(`  ~${ev.injectedTokens.toLocaleString()} tokens`));
    if (ev.tags?.length) meta.push(chalk.yellow(`  #${ev.tags.join(" #")}`));
    if (ev.outcome === "error") meta.push(chalk.red("  ✗ errored"));
    const metaLine = meta.length ? `\n       ${meta.join("  ")}` : "";

    lines.push(`  ${dot}${viaGlyph(ev)} ${time}  ${name}  ${src}  ${trigger}${metaLine}`);
  }

  if (totalPages > 1 && clampedPage < totalPages) {
    lines.push("");
    lines.push(
      chalk.gray(
        `  … ${sorted.length - clampedPage * perPage} more — next: cc-skill-trace show --page ${clampedPage + 1}`
      )
    );
  }

  lines.push("");
  lines.push(hr("─"));
  lines.push(
    chalk.gray("  ⚡ live-captured   ≡ scan-backfilled   ") +
      chalk.underline.gray("cc-skill-trace report") +
      chalk.gray("  → browser dashboard")
  );
  lines.push(hr("═"));

  return lines.join("\n");
}

// ─── Compact list ─────────────────────────────────────────────────────────────

/** Available columns for renderCompact (#168). */
export const COMPACT_COLUMNS = [
  "time",
  "date",
  "skill",
  "source",
  "via",
  "trigger",
  "session",
  "cwd",
  "branch",
  "tokens",
] as const;
export type CompactColumn = (typeof COMPACT_COLUMNS)[number];

const DEFAULT_COLUMNS: CompactColumn[] = ["time", "skill", "source", "trigger"];

export function renderCompact(
  events: SkillInvocationEvent[],
  columns: CompactColumn[] = DEFAULT_COLUMNS
): string {
  const widths: Record<CompactColumn, number> = {
    time: 13,
    date: 11,
    skill: 22 + 9,
    source: 8,
    via: 4,
    trigger: 35,
    session: 20,
    cwd: 28,
    branch: 16,
    tokens: 8,
  };
  const cell = (ev: SkillInvocationEvent, col: CompactColumn): string => {
    switch (col) {
      case "time":
        return chalk.gray(fmtTime(ev.timestamp));
      case "date":
        return chalk.gray(ev.timestamp.slice(0, 10));
      case "skill":
        return padRight(chalk.bold.yellow(displayName(ev.skillName)), widths.skill);
      case "source":
        return ev.source === "claude" ? chalk.magenta("🤖 auto") : chalk.cyan("👤 user");
      case "via":
        return viaGlyph(ev);
      case "trigger":
        return chalk.gray((ev.triggerMessage ?? "").replace(/\n/g, " ").slice(0, widths.trigger));
      case "session":
        return chalk.gray(ev.sessionId.slice(0, widths.session));
      case "cwd":
        return chalk.gray((ev.cwd ?? "").slice(-widths.cwd));
      case "branch":
        return chalk.gray((ev.gitBranch ?? "").slice(0, widths.branch));
      case "tokens":
        return chalk.gray(ev.injectedTokens != null ? `~${ev.injectedTokens}` : "");
    }
  };
  const lines: string[] = [];
  lines.push(
    chalk.gray(columns.map((c) => c.padEnd(c === "skill" ? 22 : c === "time" ? 13 : 10)).join(" "))
  );
  lines.push(chalk.gray("─".repeat(W())));
  for (const ev of [...events].reverse()) {
    lines.push(columns.map((c) => cell(ev, c)).join("  "));
  }
  return lines.join("\n");
}

// ─── Terse (AI-optimised, minimal tokens) ─────────────────────────────────────
// Used by SKILL.md to minimise context consumption when /skill-trace fires.
// No ANSI, no padding — pure signal for the model.

export function renderTerse(events: SkillInvocationEvent[]): string {
  if (events.length === 0) {
    return "0 events. Run: cc-skill-trace install then restart Claude Code.";
  }

  const total = events.length;
  const auto = events.filter((e) => e.source === "claude").length;
  const rate = Math.round((auto / total) * 100);
  const skills = buildStats(events);

  // "11ev 72%auto | commit:5(4a) review:3(2a) …"
  const skillSummary = skills
    .slice(0, 8)
    .map((s) => `${s.name}:${s.total}(${s.auto}a)`)
    .join(" ");
  const lines: string[] = [`${total}ev ${rate}%auto | ${skillSummary}`];

  // "14:34 commit auto "trigger text""
  for (const ev of [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp))) {
    const t = new Date(ev.timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const src = ev.source === "claude" ? "auto" : "user";
    const trig = ev.triggerMessage
      ? ` "${ev.triggerMessage.replace(/\n/g, " ").slice(0, 40)}"`
      : "";
    lines.push(`${t} ${ev.skillName} ${src}${trig}`);
  }

  return lines.join("\n");
}
