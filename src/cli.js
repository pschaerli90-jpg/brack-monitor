import { Store } from './store.js';
import { MockScanner, MockTelegram } from './mocks.js';
import { jsonLogger } from './monitor.js';
import { runFourMonitor } from './four-monitor.js';
import { MOCK_ACCOUNTS, MockAccountAdapter } from './accounts.js';
import { fileURLToPath } from 'node:url';

try {
  const result = await runFourMonitor({
    store: new Store(fileURLToPath(new URL('../data/four-accounts/', import.meta.url))),
    accounts: MOCK_ACCOUNTS, adapter: new MockAccountAdapter(),
    scanner: new MockScanner(), telegram: new MockTelegram()
  });
  if (result.failed) process.exitCode = 1;
} catch (err) {
  jsonLogger({ event: 'fatal', error: err.message });
  process.exitCode = 1;
}
