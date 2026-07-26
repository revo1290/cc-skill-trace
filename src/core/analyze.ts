import type { SkillInvocationEvent } from "./types.js";

// ─── Token estimation ────────────────────────────────────────────────────────

/**
 * Estimate the number of model tokens in a text (#123).
 *
 * Heuristic: ASCII text averages ~4 characters per token; CJK and other
 * non-ASCII scripts average ~1.5 characters per token. This is a rough
 * estimate — good enough for relative comparisons, not billing.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else nonAscii++;
  }
  return Math.round(ascii / 4 + nonAscii / 1.5);
}

// ─── Auto-trigger analysis (#41, #47) ────────────────────────────────────────

/** Per-skill auto-trigger diagnosis produced by {@link analyzeAutoTriggers}. */
export interface AutoTriggerFinding {
  skillName: string;
  total: number;
  auto: number;
  /** 0–100 */
  autoRate: number;
  /** Number of distinct trigger messages seen for auto invocations. */
  distinctTriggers: number;
  /** Sessions where this skill auto-fired 3+ times. */
  burstSessions: string[];
  /** "high" = likely over-triggering, "medium" = worth a look, "low" = fine. */
  severity: "high" | "medium" | "low";
  /** Human-readable suggestions for the skill author. */
  suggestions: string[];
}

/**
 * Detect skills that look like they are over-triggering (#41).
 * Returns findings sorted most-suspicious first.
 */
export function analyzeAutoTriggers(events: SkillInvocationEvent[]): AutoTriggerFinding[] {
  const bySkill = new Map<string, SkillInvocationEvent[]>();
  for (const ev of events) {
    const list = bySkill.get(ev.skillName) ?? [];
    list.push(ev);
    bySkill.set(ev.skillName, list);
  }

  const findings: AutoTriggerFinding[] = [];
  for (const [skillName, evs] of bySkill) {
    const auto = evs.filter((e) => e.source === "claude");
    const autoRate = evs.length === 0 ? 0 : Math.round((auto.length / evs.length) * 100);
    const distinctTriggers = new Set(
      auto.map((e) => (e.triggerMessage ?? "").trim()).filter(Boolean)
    ).size;

    const perSession = new Map<string, number>();
    for (const e of auto) perSession.set(e.sessionId, (perSession.get(e.sessionId) ?? 0) + 1);
    const burstSessions = [...perSession.entries()].filter(([, n]) => n >= 3).map(([s]) => s);

    const suggestions: string[] = [];
    let severity: AutoTriggerFinding["severity"] = "low";
    if (auto.length >= 5 && autoRate >= 80) {
      severity = "high";
      suggestions.push(
        `${autoRate}% of ${evs.length} invocations were auto-triggered — tighten the skill's \`description:\` to name explicit user intents.`
      );
    } else if (auto.length >= 3 && autoRate >= 60) {
      severity = "medium";
      suggestions.push(
        `Auto-trigger rate is ${autoRate}% — check whether these firings matched real user intent.`
      );
    }
    if (burstSessions.length > 0) {
      if (severity === "low") severity = "medium";
      suggestions.push(
        `Auto-fired 3+ times within ${burstSessions.length} session(s) — the description may match generic conversation; add "Skip when …" guidance.`
      );
    }
    if (auto.length >= 5 && distinctTriggers >= auto.length * 0.8) {
      if (severity === "low") severity = "medium";
      suggestions.push(
        `Triggered by ${distinctTriggers} distinct messages — the description may be too broad.`
      );
    }

    findings.push({
      skillName,
      total: evs.length,
      auto: auto.length,
      autoRate,
      distinctTriggers,
      burstSessions,
      severity,
      suggestions,
    });
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity] || b.auto - a.auto);
}

// ─── Period diff (#44, #47) ──────────────────────────────────────────────────

/** Per-skill comparison row produced by {@link diffPeriods}. */
export interface PeriodDiffRow {
  skillName: string;
  countA: number;
  countB: number;
  delta: number;
  autoRateA: number;
  autoRateB: number;
}

/** Bounds of one comparison period (ISO strings, inclusive). */
export interface Period {
  since?: string;
  before?: string;
}

function inPeriod(ev: SkillInvocationEvent, p: Period): boolean {
  if (p.since && ev.timestamp < p.since) return false;
  if (p.before && ev.timestamp > p.before) return false;
  return true;
}

/**
 * Compare skill usage between two date ranges (#44).
 * Returns one row per skill seen in either period, sorted by |delta| descending.
 */
export function diffPeriods(
  events: SkillInvocationEvent[],
  periodA: Period,
  periodB: Period
): PeriodDiffRow[] {
  const acc = new Map<string, { a: number; aAuto: number; b: number; bAuto: number }>();
  for (const ev of events) {
    const a = inPeriod(ev, periodA);
    const b = inPeriod(ev, periodB);
    if (!a && !b) continue;
    const row = acc.get(ev.skillName) ?? { a: 0, aAuto: 0, b: 0, bAuto: 0 };
    if (a) {
      row.a++;
      if (ev.source === "claude") row.aAuto++;
    }
    if (b) {
      row.b++;
      if (ev.source === "claude") row.bAuto++;
    }
    acc.set(ev.skillName, row);
  }
  const rate = (auto: number, total: number) =>
    total === 0 ? 0 : Math.round((auto / total) * 100);
  return [...acc.entries()]
    .map(([skillName, r]) => ({
      skillName,
      countA: r.a,
      countB: r.b,
      delta: r.b - r.a,
      autoRateA: rate(r.aAuto, r.a),
      autoRateB: rate(r.bAuto, r.b),
    }))
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}

// ─── Time-of-day histogram (#160) ────────────────────────────────────────────

/** Count invocations per local hour of day. Returns an array of 24 counts. */
export function hourHistogram(events: SkillInvocationEvent[]): number[] {
  const hours = new Array<number>(24).fill(0);
  for (const ev of events) {
    const h = new Date(ev.timestamp).getHours();
    if (h >= 0 && h < 24) hours[h] = (hours[h] ?? 0) + 1;
  }
  return hours;
}

// ─── Usage streaks (#166) ────────────────────────────────────────────────────

/** Consecutive-day usage streaks computed from event timestamps (local days). */
export interface StreakInfo {
  /** Days in the streak ending today (or yesterday, if today has no events yet). */
  current: number;
  /** Longest consecutive-day run in the data. */
  longest: number;
}

/** Compute current/longest consecutive-day usage streaks (#166). */
export function computeStreaks(events: SkillInvocationEvent[], today = new Date()): StreakInfo {
  const days = new Set<string>();
  for (const ev of events) {
    const d = new Date(ev.timestamp);
    days.add(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    );
  }
  if (days.size === 0) return { current: 0, longest: 0 };

  const sorted = [...days].sort();
  let longest = 1;
  let run = 1;
  const dayMs = 24 * 60 * 60 * 1000;
  const toUtc = (s: string) => Date.parse(`${s}T00:00:00Z`);
  for (let i = 1; i < sorted.length; i++) {
    if (toUtc(sorted[i]!) - toUtc(sorted[i - 1]!) === dayMs) run++;
    else run = 1;
    if (run > longest) longest = run;
  }

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayKey = fmt(today);
  const yesterday = new Date(today.getTime() - dayMs);
  const anchor = days.has(todayKey) ? todayKey : days.has(fmt(yesterday)) ? fmt(yesterday) : null;
  let current = 0;
  if (anchor) {
    current = 1;
    let cursor = toUtc(anchor);
    while (days.has(new Date(cursor - dayMs).toISOString().slice(0, 10))) {
      current++;
      cursor -= dayMs;
    }
  }
  return { current, longest };
}

// ─── Per-cwd aggregation (#135) ──────────────────────────────────────────────

/** Per-working-directory invocation counts. */
export interface CwdStat {
  cwd: string;
  total: number;
  auto: number;
}

/** Aggregate events per working directory, sorted by count (#135). */
export function groupByCwd(events: SkillInvocationEvent[]): CwdStat[] {
  const map = new Map<string, CwdStat>();
  for (const ev of events) {
    const cwd = ev.cwd ?? "(unknown)";
    const row = map.get(cwd) ?? { cwd, total: 0, auto: 0 };
    row.total++;
    if (ev.source === "claude") row.auto++;
    map.set(cwd, row);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// ─── Cost estimation (#49) ───────────────────────────────────────────────────

/** USD per million input tokens, by model family. Rough public list prices. */
export const MODEL_INPUT_PRICES_PER_MTOK: Record<string, number> = {
  opus: 15,
  sonnet: 3,
  haiku: 1,
};

/** Result of {@link estimateCost}. */
export interface CostEstimate {
  model: string;
  pricePerMTok: number;
  /** Events that carried an injectedTokens measurement. */
  measuredEvents: number;
  totalInjectedTokens: number;
  estimatedUSD: number;
  perSkill: Array<{ skillName: string; tokens: number; usd: number }>;
}

/**
 * Estimate the input-token cost of skill content injections (#49).
 * Only events with a recorded `injectedTokens` contribute; the result is a
 * lower bound and an approximation, not a bill.
 */
export function estimateCost(events: SkillInvocationEvent[], model = "sonnet"): CostEstimate {
  const key = model.toLowerCase().includes("opus")
    ? "opus"
    : model.toLowerCase().includes("haiku")
      ? "haiku"
      : "sonnet";
  const price = MODEL_INPUT_PRICES_PER_MTOK[key]!;
  const perSkill = new Map<string, number>();
  let total = 0;
  let measured = 0;
  for (const ev of events) {
    if (ev.injectedTokens == null) continue;
    measured++;
    total += ev.injectedTokens;
    perSkill.set(ev.skillName, (perSkill.get(ev.skillName) ?? 0) + ev.injectedTokens);
  }
  const toUsd = (tokens: number) => (tokens / 1_000_000) * price;
  return {
    model: key,
    pricePerMTok: price,
    measuredEvents: measured,
    totalInjectedTokens: total,
    estimatedUSD: toUsd(total),
    perSkill: [...perSkill.entries()]
      .map(([skillName, tokens]) => ({ skillName, tokens, usd: toUsd(tokens) }))
      .sort((a, b) => b.tokens - a.tokens),
  };
}
