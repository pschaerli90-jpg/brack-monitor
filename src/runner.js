import { setTimeout as delay } from 'node:timers/promises';

// Await each whole run; the Store additionally excludes independent processes.
export async function runLoop({ run, watch = false, intervalMs = 60000, signal,
  sleep = (ms, abort) => delay(ms, undefined, { signal: abort }) }) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000) throw new Error('Scanintervall muss mindestens 60 Sekunden betragen');
  let result;
  while (!signal?.aborted) {
    result = await run();
    if (!watch || result.halted) return result;
    try { await sleep(Math.max(intervalMs, result.retryAfterMs ?? 0), signal); }
    catch (err) { if (err.name !== 'AbortError') throw err; return result; }
  }
  return result;
}
