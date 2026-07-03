// Helpers for the `show --follow` live-tail loop.

/**
 * Wrap an async function so that overlapping invocations are skipped.
 *
 * While a call is still in-flight, any further calls return immediately
 * without invoking `fn` again. `setInterval` ignores the promise returned
 * by its callback, so a `tick` that takes longer than the interval would
 * otherwise start running concurrently with the next one — interleaving
 * `stdout` writes (screen clears + dashboard renders) and producing
 * flickering / garbled output. Guarding the callback keeps at most one
 * `tick` running at a time; ticks that fire mid-render are simply dropped.
 *
 * See https://github.com/revo1290/cc-skill-trace/issues/186
 */
export function skipWhileRunning(fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } finally {
      running = false;
    }
  };
}
