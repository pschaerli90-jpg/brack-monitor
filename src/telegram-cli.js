import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { BrackScanner } from './brack/scanner.js';
import { runLoop } from './runner.js';
import { jsonLogger } from './monitor.js';
import { notificationOptions } from './telegram/cli-options.js';
import { loadTelegramConfig } from './telegram/config.js';
import { TelegramClient } from './telegram/client.js';
import { SimulatedTelegramDelivery } from './telegram/message.js';
import { runDiscoveryMonitor } from './telegram/outbox.js';

try {
  const options = notificationOptions(process.argv.slice(2));
  // Test mode never reads token or chat ID, even if such variables are present.
  const telegram = options.mode === 'telegram' ? new TelegramClient(await loadTelegramConfig({ path: options.config })) :
    new SimulatedTelegramDelivery();
  const scanner = new BrackScanner({ http: options.fixture ? { get: () => readFile(options.fixture, 'utf8') } : undefined });
  const source = options.fixture ? 'fixture' : 'brack';
  const directory = options.stateDirectory ?? fileURLToPath(new URL(options.fixture ? '../data/telegram-discovery-fixture/' :
    options.mode === 'telegram' ? '../data/telegram-discovery/' : '../data/telegram-discovery-test/', import.meta.url));
  const store = new Store(directory);
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  jsonLogger({ event: 'discovery_monitor_started', mode: telegram.mode, source, watch: options.watch });
  let manual = true;
  const result = await runLoop({ watch: options.watch, intervalMs: options.intervalMs, signal: abort.signal,
    run: async () => {
      const result = await runDiscoveryMonitor({ scanner, telegram, store, source,
        baseline: manual && options.baseline, retryFailed: manual ? options.retryFailed : undefined,
        acknowledgeUncertain: manual ? options.acknowledgeUncertain : undefined });
      if (!options.baseline || result.scanSucceeded) manual = false;
      return result;
    } });
  if (result?.failed || result?.held) process.exitCode = 1;
} catch {
  // Never print a raw error/cause: request URLs can contain a bot token.
  jsonLogger({ event: 'discovery_fatal', error: 'Benachrichtigung abgebrochen; lokale Konfiguration, Optionen und Zustand prüfen' });
  process.exitCode = 1;
}
