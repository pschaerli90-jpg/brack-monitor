import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { MOCK_ACCOUNTS, MockAccountAdapter } from './accounts.js';
import { runFourMonitor } from './four-monitor.js';
import { jsonLogger } from './monitor.js';
import { BrackScanner } from './brack/scanner.js';
import { TestLimitsPolicy } from './brack/limits-policy.js';
import { TelegramPreview } from './notification.js';
import { runLoop } from './runner.js';

try {
  const args = process.argv.slice(2);
  let watch = false, intervalMs = 60000, fixture, limitsFile;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--watch') watch = true;
    else if (['--fixture', '--limits', '--interval-seconds'].includes(arg)) {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error('Wert fehlt für ' + arg);
      if (arg === '--fixture') fixture = value;
      else if (arg === '--limits') limitsFile = value;
      else intervalMs = Number(value) * 1000;
    } else throw new Error('Unbekanntes Argument: ' + arg + '. Nur Lesemodus verfügbar.');
  }
  // Preserve the existing read-only scanner's minimum independently of Telegram.
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60000) throw new Error('Scanintervall muss mindestens 60 Sekunden betragen');
  const policy = limitsFile ? await TestLimitsPolicy.fromFile(limitsFile) : null;
  const http = fixture ? { get: async () => readFile(fixture, 'utf8') } : undefined;
  const scanner = new BrackScanner({ http, policy });
  const abort = new AbortController();
  process.once('SIGINT', () => abort.abort());
  process.once('SIGTERM', () => abort.abort());
  jsonLogger({ event: 'read_only_started', source: fixture ? 'fixture' : 'brack-public-listing',
    accounts: 4, cart: 'simulation', telegram: 'preview-only', watch });
  const store = new Store(fileURLToPath(new URL(fixture ? '../data/brack-fixture/' : '../data/brack-read-only/', import.meta.url)));
  const result = await runLoop({ watch, intervalMs, signal: abort.signal,
    run: () => runFourMonitor({ scanner, store, accounts: MOCK_ACCOUNTS,
      adapter: new MockAccountAdapter(), telegram: new TelegramPreview() }) });
  if (result?.failed) process.exitCode = 1;
} catch (err) {
  jsonLogger({ event: 'read_only_fatal', error: err.message });
  process.exitCode = 1;
}
