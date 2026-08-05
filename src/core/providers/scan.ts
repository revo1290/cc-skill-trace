import { mapWithLimit } from "../parser.js";
import type { ExtractAllOptions } from "../parser.js";
import type { SkillInvocationEvent } from "../types.js";
import type { Provider } from "./types.js";

/**
 * Scan-and-extract for any provider that implements `listSessionFiles` +
 * `extractInvocationsFromFile` (mirrors `extractAllInvocations` in
 * `../parser.ts`, which stays Claude-Code-specific and untouched since it's
 * the stable, most heavily tested path).
 */
export async function extractAllInvocationsForProvider(
  provider: Provider,
  opts: ExtractAllOptions = {}
): Promise<SkillInvocationEvent[]> {
  const { extractInvocationsFromFile } = provider;
  if (!provider.supportsScan || !provider.listSessionFiles || !extractInvocationsFromFile) {
    throw new Error(`${provider.displayName} does not support scanning session logs.`);
  }
  const skills = await provider.listInstalledSkills();

  let fileInfos = await provider.listSessionFiles(opts.sessionId);
  if (opts.sessionId && fileInfos.length === 0) {
    fileInfos = await provider.listSessionFiles();
  }
  if (opts.modifiedAfterMs != null) {
    const modifiedAfterMs = opts.modifiedAfterMs;
    fileInfos = fileInfos.filter((f) => f.mtimeMs > modifiedAfterMs);
  }
  let files = fileInfos.map((f) => f.path);
  if (opts.files) {
    const allow = new Set(opts.files);
    files = files.filter((f) => allow.has(f));
  }

  const allEvents: SkillInvocationEvent[] = [];
  let done = 0;
  const concurrency = Math.max(1, parseInt(process.env.CC_SCAN_CONCURRENCY ?? "8", 10) || 8);
  await mapWithLimit(files, concurrency, async (file) => {
    try {
      const events = await extractInvocationsFromFile(file, skills, opts);
      for (const ev of events) {
        if (opts.since && ev.timestamp < opts.since) continue;
        if (opts.sessionId && ev.sessionId !== opts.sessionId) continue;
        allEvents.push(ev);
      }
    } catch {
      // skip unreadable files
    }
    opts.onProgress?.(++done, files.length, file);
  });

  return allEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
