import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { mergeEventSources } from "../../core/store.js";
import type { SkillInvocationEvent } from "../../core/types.js";
import { fail } from "../ui.js";
import { guardOverwrite } from "./export.js";

/**
 * `merge` (#226): merge events from multiple ad hoc sources into one
 * deduped, timestamp-sorted events file.
 *
 * This is the *file*-oriented counterpart to the programmatic
 * `mergeStores()` (which merges store *directories* only, and backs
 * `export --merge`). `merge` instead targets what teams actually pass
 * around — an `export --format json` array, a raw `events.jsonl` copied off
 * another machine, or (as a convenience) a store directory containing one —
 * so it can accept any mix of those as positional sources.
 */
export function registerMergeCommand(program: Command): void {
  program
    .command("merge <sources...>")
    .description(
      "Merge events from multiple sources into one deduped, timestamp-sorted events file (#226)"
    )
    .summary("Merge events from multiple export files/stores into one file")
    .option(
      "--out <path>",
      "Output path for the merged events (required), written as JSONL. To read it back via " +
        "--store/CC_STORE_DIR, name it events.jsonl and point --store at its parent directory " +
        "(--store always reads <dir>/events.jsonl)"
    )
    .option("-f, --force", "Overwrite --out without asking")
    .addHelpText(
      "after",
      `
Each <source> may be:
  - a JSON array file, as written by \`cc-skill-trace export --format json\`
  - a raw events.jsonl file (one JSON event per line)
  - a store directory containing events.jsonl (e.g. ~/.cc-skill-trace)

Events are de-duplicated by ID (first occurrence wins) and sorted by
timestamp, reusing the same rule as the programmatic mergeStores(). Unlike
mergeStores(), which only accepts store directories, this command also
accepts individual export files.

--store/CC_STORE_DIR always reads "<dir>/events.jsonl", so to make the merged
output readable that way, write it to a path literally named events.jsonl
and pass --store its parent directory:

Examples:
  $ cc-skill-trace merge ~/exports/alice-events.jsonl ~/exports/bob-events.jsonl --out ./team-store/events.jsonl
  $ cc-skill-trace stats --store ./team-store
`
    )
    .action(async (sources: string[], opts: { out?: string; force?: boolean }) => {
      if (!opts.out) {
        fail("--out <path> is required — where should the merged events be written?");
      }
      const outPath = opts.out;
      await guardOverwrite(outPath, Boolean(opts.force));

      let events: SkillInvocationEvent[];
      let duplicates: number;
      try {
        ({ events, duplicates } = await mergeEventSources(sources));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }

      try {
        await mkdir(dirname(outPath), { recursive: true });
        await writeFile(
          outPath,
          events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""),
          "utf-8"
        );
      } catch (err) {
        return fail(
          `Could not write ${outPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      console.log(
        chalk.green(
          `✓  Merged ${sources.length} source${sources.length === 1 ? "" : "s"} → ` +
            `${events.length} event${events.length === 1 ? "" : "s"} ` +
            `(${duplicates} duplicate${duplicates === 1 ? "" : "s"} dropped) → ${outPath}`
        )
      );
    });
}
