import chalk from "chalk";

/**
 * Parse a human-friendly relative duration into a cutoff Date (now − duration).
 *
 * Supported units: `min` (minutes), `h` (hours), `d` (days), `w` (weeks).
 * `min` is spelled out rather than `m` to avoid a future clash with months
 * (`mo`, see #93).
 *
 * On invalid input, prints an error and exits the process (CLI behavior).
 */
export function parseDuration(value: string): Date {
  const match = /^(\d+)(min|h|d|w)$/i.exec(value);
  if (!match) {
    console.error(
      chalk.red(`✗  Invalid duration: "${value}". Expected format: 30min, 12h, 30d, or 4w`)
    );
    process.exit(1);
  }
  const n = parseInt(match[1]!, 10);
  const unit = match[2]?.toLowerCase();
  const cutoff = new Date();
  if (unit === "min") cutoff.setMinutes(cutoff.getMinutes() - n);
  else if (unit === "h") cutoff.setHours(cutoff.getHours() - n);
  else if (unit === "d") cutoff.setDate(cutoff.getDate() - n);
  else cutoff.setDate(cutoff.getDate() - n * 7);
  return cutoff;
}
