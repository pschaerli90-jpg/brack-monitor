import { createInterface } from 'node:readline/promises';
import { SessionVault } from './brack/session-vault.js';
import { RealAccountAdapter, enrolSession } from './brack/real-account-adapter.js';
import { realAccounts, validateContract, AccountError } from './brack/account-contract.js';
import { accountOptions } from './brack/account-options.js';
import { AccountStore } from './brack/account-store.js';
import { BrackScanner } from './brack/scanner.js';
import { runFourMonitor } from './four-monitor.js';
import { runLoop } from './runner.js';
import { jsonLogger } from './monitor.js';
import { TelegramClient } from './telegram/client.js';
import { loadTelegramConfig } from './telegram/config.js';
import { SimulatedTelegramDelivery } from './telegram/message.js';

process.umask(0o077);
try {
  const options = accountOptions(process.argv.slice(2));
  const vault = new SessionVault(options.vault);
  await vault.locked(async () => {
    const contract = validateContract(await vault.read('contract.json'));
    // Optional dependency: existing scanner and notification commands do not load it.
    const { request, chromium } = await import('playwright');
    if (options.login) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new AccountError('interactive_login_required');
      await enrolSession({ accountId: options.login, vault, contract, chromium,
        confirm: async () => {
          const input = createInterface({ input: process.stdin, output: process.stdout });
          try {
            const answer = await input.question('Nur dieses Konto manuell bei BRACK anmelden; keinen Warenkorb ändern. Bei CAPTCHA/Zugriffsschutz abbrechen. Danach "angemeldet" eingeben: ');
            if (answer !== 'angemeldet') throw new AccountError('login_cancelled');
          } finally { input.close(); }
        } });
      jsonLogger({ event: 'account_session_saved', accountId: options.login });
      return;
    }
    const adapter = new RealAccountAdapter({ vault, contract, write: options.write,
      requestFactory: config => request.newContext(config) });
    try {
      await adapter.initialise();
      const accounts = realAccounts();
      if (options.inspect) {
        for (const account of accounts) {
          try {
            const cart = await adapter.readCart(account);
            jsonLogger({ event: 'account_cart_read', accountId: account.id, authenticated: true,
              positions: Object.keys(cart.items).length, observedAt: cart.observedAt, writes: false });
          } catch (e) {
            process.exitCode = 1;
            jsonLogger({ event: 'account_cart_read_failed', accountId: account.id, writes: false });
            if (e instanceof AccountError && (e.halt || e.retryAfterMs)) break;
          }
        }
        return;
      }
      const telegram = options.telegram ? new TelegramClient(await loadTelegramConfig({ path: options.config })) :
        new SimulatedTelegramDelivery();
      const scanner = new BrackScanner(); // Same scanner, no test limit policy.
      const store = new AccountStore(vault, adapter.operation);
      const abort = new AbortController();
      process.once('SIGINT', () => abort.abort());
      process.once('SIGTERM', () => abort.abort());
      // A newly approved writer first records the existing catalogue. It must
      // not fill every historic product when switching from read-test to write.
      let baseline = options.baseline || (options.write && !(await store.load()).discovery?.initialScanAt);
      jsonLogger({ event: 'account_monitor_started', operation: adapter.operation, accounts: 4, checkout: false });
      const result = await runLoop({ watch: options.watch, intervalMs: options.intervalMs, signal: abort.signal,
        run: async () => {
          const result = await runFourMonitor({ scanner, accounts, adapter, telegram, store, baseline });
          if (result.scanSucceeded) baseline = false;
          return result;
        } });
      if (result?.failed || result?.held || result?.cartFailed || result?.halted) process.exitCode = 1;
    } finally { await adapter.close(); }
  });
} catch {
  jsonLogger({ event: 'account_fatal', error: 'Kontobetrieb angehalten; private Konfiguration, Sitzung, Freigabe und Sperren lokal prüfen' });
  process.exitCode = 1;
}
