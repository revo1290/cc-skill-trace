import chalk from "chalk";
import type { Command } from "commander";
import { analyzeAutoTriggers } from "../../core/analyze.js";
import { getProvider } from "../../core/providers/index.js";
import { readEvents } from "../../core/store.js";
import {
  buildStats,
  displayName,
  renderCost,
  renderDiagnose,
  renderStats,
  sortStats,
} from "../format.js";
import {
  addFilterOptions,
  filterFromOpts,
  parseDateOpt,
  parseLimitOpt,
  parseProviderOpt,
} from "../options.js";
import { fail } from "../ui.js";
import { scanAndMerge } from "./scan.js";

export function registerStatsCommands(program: Command): void {
  // ── stats ──────────────────────────────────────────────────────────────
  const stats = program
    .command("stats")
    .description("Show aggregated activity: daily, hour-of-day, streaks, sessions, directories");
  addFilterOptions(stats)
    .option("--days <n>", "Daily-activity window in days (default 14) (#102)", parseLimitOpt)
    .option("--limit <n>", "Rows per section (default 5) (#191)", parseLimitOpt)
    .option("--cost [model]", "Estimate injected-token cost; model: sonnet|opus|haiku (#49)")
    .option("--scan", "Scan session logs first")
    .action(async (opts) => {
      const filter = filterFromOpts(opts);
      if (opts.scan) {
        const { fresh } = await scanAndMerge({ since: filter.since, sessionId: filter.sessionId });
        process.stderr.write(chalk.gray(`  Imported ${fresh.length} new invocations.\n\n`));
      }
      const events = await readEvents(filter);
      if (opts.cost) {
        console.log(renderCost(events, typeof opts.cost === "string" ? opts.cost : "sonnet"));
        return;
      }
      console.log(
        renderStats(events, {
          days: opts.days ? parseInt(String(opts.days), 10) : undefined,
          limit: opts.limit ? parseInt(String(opts.limit), 10) : undefined,
        })
      );
    });

  // ── list-skills ────────────────────────────────────────────────────────
  program
    .command("list-skills")
    .alias("ls")
    .description("List all unique skills seen, with invocation counts")
    .option("--since <date>", "Filter from this date", parseDateOpt)
    .option("--before <date>", "Filter up to this date", parseDateOpt)
    .option("--session <id>", "Filter by session ID (#219)")
    .option("--sort <by>", "Sort by: count | name | auto (#103)", "count")
    .option("--scan", "Scan session logs first")
    .option("--json", "Output as JSON")
    .option(
      "--provider <id>",
      "Filter by agent CLI: claude-code, codex or copilot (#v3-multi-provider)",
      parseProviderOpt
    )
    .option(
      "--installed",
      "List skills installed on disk for --provider instead of invocation counts (#v3-multi-provider)"
    )
    .action(async (opts) => {
      const sortBy = String(opts.sort).toLowerCase();
      if (!["count", "name", "auto"].includes(sortBy)) {
        fail(`Invalid --sort: "${opts.sort}". Use count, name or auto.`);
      }

      if (opts.installed) {
        const provider = getProvider(opts.provider ?? "claude-code");
        const skills = await provider.listInstalledSkills();
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(skills, null, 2)}\n`);
          return;
        }
        if (skills.length === 0) {
          console.log(chalk.gray(`  No skills installed for ${provider.displayName}.`));
          return;
        }
        const maxName = Math.max(...skills.map((s) => s.name.length));
        for (const s of skills) {
          console.log(
            `  ${chalk.bold.yellow(s.name.padEnd(maxName))}  ${chalk.gray(s.description ?? "")}`
          );
          console.log(chalk.gray(`  ${" ".repeat(maxName)}  ${s.path}`));
        }
        return;
      }

      if (opts.scan) {
        const { fresh } = await scanAndMerge({ since: opts.since, sessionId: opts.session });
        process.stderr.write(chalk.gray(`  Imported ${fresh.length} new invocations.\n\n`));
      }
      const events = await readEvents({
        since: opts.since,
        before: opts.before,
        sessionId: opts.session,
        provider: opts.provider,
      });
      const stats = sortStats(buildStats(events), sortBy as "count" | "name" | "auto");

      if (opts.json) {
        process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
        return;
      }

      if (stats.length === 0) {
        console.log(chalk.gray("  No skills recorded yet."));
        console.log(chalk.gray("  Run: cc-skill-trace install  then use Claude Code."));
        return;
      }

      const maxName = Math.max(...stats.map((s) => displayName(s.name).length));
      console.log(chalk.gray(`  ${"skill".padEnd(maxName)}   total  auto  user  auto%`));
      console.log(chalk.gray(`  ${"─".repeat(maxName + 27)}`));
      for (const s of stats) {
        console.log(
          `  ${chalk.bold.yellow(displayName(s.name).padEnd(maxName))}` +
            `  ${chalk.white(String(s.total).padStart(5))}${chalk.gray("x")}` +
            `  ${chalk.magenta(String(s.auto).padStart(4))}` +
            `  ${chalk.cyan(String(s.byUser).padStart(4))}` +
            `  ${chalk.gray(`${String(s.autoRate).padStart(4)}%`)}`
        );
      }
    });

  // ── diagnose (#41) ─────────────────────────────────────────────────────
  const diagnose = program
    .command("diagnose")
    .description("Detect over-triggering skills and suggest description fixes (#41)");
  addFilterOptions(diagnose)
    .option("--json", "Output findings as JSON")
    .option("--scan", "Scan session logs first")
    .action(async (opts) => {
      const filter = filterFromOpts(opts);
      if (opts.scan) {
        await scanAndMerge({ since: filter.since, sessionId: filter.sessionId });
      }
      const events = await readEvents(filter);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(analyzeAutoTriggers(events), null, 2)}\n`);
        return;
      }
      console.log(renderDiagnose(events));
    });

  // ── check (#42): CI/CD gate ────────────────────────────────────────────
  const check = program
    .command("check")
    .description("CI gate: exit 1 when auto-rate or invocation count exceeds thresholds (#42)");
  addFilterOptions(check)
    .option(
      "--max-auto-rate <pct>",
      "Fail when overall auto-trigger rate exceeds this percentage",
      parseLimitOpt
    )
    .option("--max-invocations <n>", "Fail when total invocations exceed this count", parseLimitOpt)
    .option(
      "--min-invocations <n>",
      "Fail when total invocations are below this count",
      parseLimitOpt
    )
    .action(async (opts) => {
      if (!opts.maxAutoRate && !opts.maxInvocations && !opts.minInvocations) {
        fail(
          "check needs at least one threshold: --max-auto-rate, --max-invocations or --min-invocations"
        );
      }
      const filter = filterFromOpts(opts);
      const events = await readEvents(filter);
      const total = events.length;
      const auto = events.filter((e) => e.source === "claude").length;
      const autoRate = total === 0 ? 0 : Math.round((auto / total) * 100);

      const failures: string[] = [];
      if (opts.maxAutoRate != null && autoRate > parseInt(String(opts.maxAutoRate), 10)) {
        failures.push(
          `auto-trigger rate ${autoRate}% exceeds --max-auto-rate ${opts.maxAutoRate}%`
        );
      }
      if (opts.maxInvocations != null && total > parseInt(String(opts.maxInvocations), 10)) {
        failures.push(`invocation count ${total} exceeds --max-invocations ${opts.maxInvocations}`);
      }
      if (opts.minInvocations != null && total < parseInt(String(opts.minInvocations), 10)) {
        failures.push(
          `invocation count ${total} is below --min-invocations ${opts.minInvocations}`
        );
      }

      console.log(chalk.gray(`  events: ${total}   auto: ${auto} (${autoRate}%)`));
      if (failures.length > 0) {
        for (const f of failures) console.error(chalk.red(`✗  ${f}`));
        process.exit(1);
      }
      console.log(chalk.green("✓  All thresholds satisfied."));
    });
}
