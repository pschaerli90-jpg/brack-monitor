import { createInterface } from 'node:readline/promises';
import { SessionVault } from './brack/session-vault.js';
import { RealAccountAdapter, enrolSession } from './brack/real-account-adapter.js';
import { realAccounts, validateContract, AccountError } from './brack/account-contract.js';
import { accountOptions } from './brack/account-options.js';
import { jsonLogger } from './monitor.js';

process.umask(0o077);
try {
  const options = accountOptions(process.argv.slice(2));
  const vault = new SessionVault(options.vault);
  await vault.locked(async () => {
    const contract = validateContract(await vault.read('contract.json'));
    // Optional dependency, never loaded by the monitoring/Telegram commands.
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
    const adapter = new RealAccountAdapter({ vault, contract, requestFactory: config => request.newContext(config) });
    try {
      await adapter.initialise();
      for (const account of realAccounts()) {
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
    } finally { await adapter.close(); }
  });
} catch {
  jsonLogger({ event: 'account_fatal', error: 'Kontoprüfung angehalten; private Konfiguration, Sitzung und Sperren lokal prüfen' });
  process.exitCode = 1;
}
