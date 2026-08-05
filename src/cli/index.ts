#!/usr/bin/env node

// Node.js version gate — Intl.Segmenter requires Node 16+, fetch/structuredClone require 18+ (#39)
const _nodeMajor = parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (_nodeMajor < 18) {
  process.stderr.write(
    `\ncc-skill-trace requires Node.js ≥ 18. You are running ${process.version}.\n` +
      "Upgrade at https://nodejs.org\n\n"
  );
  process.exit(1);
}

import { program } from "commander";
import { registerCaptureCommand } from "./commands/capture.js";
import { registerCompletionCommand } from "./commands/completion.js";
import { registerExportCommands } from "./commands/export.js";
import { registerInstallCommands } from "./commands/install.js";
import { registerScanCommand } from "./commands/scan.js";
import { registerShowCommand } from "./commands/show.js";
import { registerStatsCommands } from "./commands/stats.js";
import { getConfig, VERSION } from "./context.js";
import { configureRender } from "./format.js";
import { setupColors, setVerbose, vlog } from "./ui.js";

setupColors(); // ANSI off for pipes/CI, NO_COLOR respected (#69, #179)

program
  .name("cc-skill-trace")
  .description("Skill invocation debugger & visualizer for Claude Code")
  .version(VERSION)
  .option("--store <dir>", "Use an alternate event-store directory (#95)")
  .option("--verbose", "Print diagnostic details to stderr (#107)")
  .hook("preAction", async (thisCommand) => {
    const opts = thisCommand.opts<{ store?: string; verbose?: boolean }>();
    if (opts.store) process.env.CC_STORE_DIR = opts.store;
    setVerbose(Boolean(opts.verbose));
    // Apply persisted config to renderers (aliases #143, width cap #195).
    try {
      const config = await getConfig();
      configureRender({ aliases: config.aliases, maxWidth: config.maxWidth });
    } catch (err) {
      vlog(`config load failed, using defaults: ${err}`);
    }
  });

registerShowCommand(program);
registerScanCommand(program);
registerStatsCommands(program);
registerExportCommands(program);
registerInstallCommands(program);
registerCaptureCommand(program);
registerCompletionCommand(program);

program.parse();
