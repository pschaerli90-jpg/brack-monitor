import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, symlink, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionVault } from '../src/brack/session-vault.js';
import { AccountError, endpoint, hash, realAccounts, validateContract, validateGrant, validateRealAccounts } from '../src/brack/account-contract.js';
import { accountOptions } from '../src/brack/account-options.js';
import { enrolSession } from '../src/brack/real-account-adapter.js';
import { accountSetup, contract, session } from './helpers/accounts.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('Genau vier echte Konten; sichere Optionen und 30-Sekunden-Grenze', () => {
  validateRealAccounts(realAccounts());
  assert.throws(() => validateRealAccounts(realAccounts().slice(1)));
  assert.throws(() => validateRealAccounts([realAccounts()[0], ...realAccounts().slice(0, 3)]));
  assert.equal(accountOptions(['--vault', '/private/brack']).write, false);
  assert.equal(accountOptions(['--vault', '/private/brack', '--watch', '--interval-seconds', '30']).intervalMs, 30000);
  for (const args of [['--vault', '/p', '--interval-seconds', '29.999'], ['--vault', '/p', '--password', 'x'],
    ['--vault', '/p', '--fixture', 'x'], ['--vault', '/p', '--login', 'brack-account-5'],
    ['--vault', '/p', '--inspect', '--write-approved'], ['--vault', '/p', '--login', 'brack-account-1', '--watch'], []]) {
    assert.throws(() => accountOptions(args));
  }
});

test('Sitzungen nur ausserhalb Git; private Verzeichnisse/Dateien und keine Symlinks', async t => {
  assert.throws(() => new SessionVault(new URL('../data/private', import.meta.url).pathname));
  assert.throws(() => new SessionVault('relative'));
  const s = await accountSetup(t);
  const path = join(s.directory, 'brack-account-1/session.json');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(s.directory)).mode & 0o777, 0o700);
  await chmod(path, 0o644);
  await assert.rejects(s.vault.read('brack-account-1/session.json'), /vault_file_invalid/);
  await chmod(path, 0o600);
  await symlink(path, join(s.directory, 'write-approval.json'));
  await assert.rejects(s.vault.read('write-approval.json'), /vault_file_invalid/);
  await assert.rejects(s.vault.read('../escape'), /vault_file_invalid/);
  await chmod(s.directory, 0o755);
  await assert.rejects(s.vault.initialise(), /vault_permissions_invalid/);
});

test('Identitätsbindung weist dieselben echten Konten und vertauschte Sitzungen ab', async t => {
  const s = await accountSetup(t);
  await s.vault.save('brack-account-2/binding.json', { version: 1, ...s.bindings['brack-account-1'] });
  await assert.rejects(s.vault.bindings(), /duplicate_brack_accounts/);
  await s.vault.save('brack-account-2/binding.json', { version: 1, ...s.bindings['brack-account-2'] });
  await s.vault.save('brack-account-2/session.json', session('brack-account-1'));
  await s.locked(async () => {
    await assert.rejects(s.adapter.readCart(s.accounts[1]), /account_identity_mismatch/);
    assert.equal((await s.adapter.readCart(s.accounts[0])).accountId, 'brack-account-1');
  });
});

test('Globale Vault-Sperre verhindert parallele Login-/Scanprozesse, Adapter parallele Läufe', async t => {
  const s = await accountSetup(t);
  await s.locked(async () => {
    await assert.rejects(new SessionVault(s.directory).locked(() => assert.fail('gesperrt')), /accounts_locked/);
    await s.adapter.runExclusive(async () => {
      await assert.rejects(s.adapter.runExclusive(() => assert.fail('gesperrt')), /accounts_locked/);
    });
  });
  await assert.rejects(s.adapter.readCart(s.accounts[0]), /accounts_locked/);
});

test('Read-only-Adapter hat getrennte Cookie-Jars und führt ausschliesslich erlaubte GETs aus', async t => {
  const s = await accountSetup(t);
  await s.locked(async () => {
    for (const account of s.accounts) {
      assert.equal((await s.adapter.readCart(account)).cart, s.bindings[account.id].cart);
      await assert.rejects(s.adapter.setTarget({ account }), /cart_writes_not_approved/);
    }
  });
  assert.deepEqual([...new Set(s.requests.map(r => r.id))], s.accounts.map(a => a.id));
  assert.ok(s.requests.every(r => r.method === 'GET' && r.maxRedirects === 0 && r.maxRetries === 0));
});

test('Ungeprüfte Verträge, fremde Ziele, Checkout und unbekannte Limits sind gesperrt', async t => {
  assert.throws(() => validateContract({ ...contract(), reviewed: false }), /contract_not_reviewed/);
  for (const path of ['https://evil.example/a', '//evil.example/a', '/checkout', '/api/orders',
    '/api/%63art', '/a/../cart', '/x?target=a', '/payment', '/cart/add']) assert.throws(() => endpoint(path));
  const s = await accountSetup(t);
  s.limits.accountLimit = null;
  await s.locked(() => assert.rejects(s.adapter.readLimits(s.accounts[0], { id: '100001' }), /limits_unknown/));
  assert.doesNotThrow(() => validateContract({ ...contract(), product: null, write: null, limitSemantics: null }));
});

test('HTTP-429 pausiert, 403/503/CAPTCHA stoppen, 401 betrifft nur die Sitzung; keine Wiederholung', async t => {
  for (const status of [429, 403, 503, 401, 302, 500, 'captcha']) {
    const s = await accountSetup(t);
    s.hooks.request = () => status === 'captcha' ?
      { status: 200, headers: { 'content-type': 'text/html' }, body: '<title>CAPTCHA</title>' } :
      { status, headers: { 'retry-after': '120' }, json: {} };
    await s.locked(async () => {
      await assert.rejects(s.adapter.readCart(s.accounts[0]), e => e instanceof AccountError &&
        (status === 429 ? e.retryAfterMs === 120000 :
          [403, 503, 'captcha'].includes(status) ? e.halt : !e.halt));
    });
    assert.equal(s.requests.length, 1);
  }
});

test('Schreiben benötigt gesonderte gültige Freigabe für exakt Vertrag und Kontobindungen', async t => {
  const s = await accountSetup(t, { write: true });
  validateGrant(s.grant, s.contract, s.bindings, s.time);
  for (const change of [{ approved: false }, { expiresAt: s.time.toISOString() }, { bindings: {} },
    { contractSha256: 'a'.repeat(64) }, { operation: 'checkout' }]) {
    assert.throws(() => validateGrant({ ...s.grant, ...change }, s.contract, s.bindings, s.time));
  }
  await s.locked(async () => {
    const a = s.accounts[0], cart = await s.adapter.readCart(a);
    const limits = await s.adapter.readLimits(a, { id: '100001' });
    await s.vault.save('write-approval.json', { ...s.grant, approved: false });
    await assert.rejects(s.adapter.setTarget({ account: a, cart, limits, targetQuantity: 1,
      product: { id: '100001', source: { observedAt: s.time.toISOString() } } }), /cart_writes_not_approved/);
  });
  assert.equal(s.requests.filter(r => r.method !== 'GET').length, 0);
});

test('Interaktives Enrolment speichert Sitzung erst nach Identitätsprüfung und ohne Passwortdatei', async t => {
  const s = await accountSetup(t);
  let confirmation = false, closed = false, created = 0;
  const chromium = { launch: async () => ({
    newContext: async () => {
      created++;
      return { newPage: async () => ({ goto: async () => {} }), storageState: async () => session('brack-account-1'),
        request: { get: async () => ({ status: () => 200, headers: () => ({ 'content-type': 'application/json' }),
          json: async () => ({ subject: s.server['brack-account-1'].subject, cart: s.server['brack-account-1'].cart }),
          dispose: async () => {} }) } };
    }, close: async () => { closed = true; }
  }) };
  await s.vault.locked(() => enrolSession({ accountId: 'brack-account-1', vault: s.vault, contract: s.contract,
    chromium, confirm: async () => { confirmation = true; } }));
  assert.equal(confirmation, true); assert.equal(closed, true); assert.equal(created, 1);
  assert.deepEqual(await s.vault.read('brack-account-1/session.json'), session('brack-account-1'));
  const binding = await s.vault.read('brack-account-1/binding.json');
  assert.equal(binding.subject, hash(s.server['brack-account-1'].subject));
  assert.ok(!JSON.stringify(binding).includes(s.server['brack-account-1'].subject));
});

test('Beschädigter/öffentlich lesbarer Laufzustand wird nicht zurückgesetzt', async t => {
  const s = await accountSetup(t);
  await s.run();
  await chmod(s.deps.store.path, 0o644);
  await assert.rejects(s.run(), /account_state_permissions_invalid/);
  await chmod(s.deps.store.path, 0o600);
  await writeFile(s.deps.store.path, '{bad json');
  await assert.rejects(s.run());
  assert.equal(await readFile(s.deps.store.path, 'utf8'), '{bad json');
});

test('Unkonfigurierte echte CLI verweigert Start ohne Zustand oder Zugangsdaten im Log', async t => {
  const s = await accountSetup(t);
  await s.vault.save('contract.json', JSON.parse(await readFile(new URL('../config/brack-account-contract.example.json', import.meta.url))));
  const env = { ...process.env, TELEGRAM_BOT_TOKEN: 'SYNTHETIC-NEVER-LOG-THIS' };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(promisify(execFile)(process.execPath, ['src/accounts-cli.js', '--vault', s.directory, '--inspect'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), env, timeout: 10000 }),
  e => e.code === 1 && !(e.stdout + e.stderr).includes(env.TELEGRAM_BOT_TOKEN));
  await assert.rejects(stat(join(s.directory, 'read-test-state')), { code: 'ENOENT' });
});

test('Installierte optionale Playwright-Laufzeit isoliert vier echte API-Cookie-Jars ohne Netzwerk', async t => {
  let request;
  try { ({ request } = await import('playwright')); }
  catch { t.skip('Optionale Playwright-Abhängigkeit nicht installiert'); return; }
  const contexts = [];
  try {
    for (const a of realAccounts()) contexts.push(await request.newContext({
      storageState: session(a.id), ignoreHTTPSErrors: false, timeout: 15000
    }));
    const states = await Promise.all(contexts.map(c => c.storageState()));
    assert.deepEqual(states.map(s => s.cookies.find(c => c.name === 'session').value), realAccounts().map(a => a.id));
  } finally { for (const c of contexts) await c.dispose(); }
});
