import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { MOCK_ACCOUNTS, MockAccountAdapter } from '../src/accounts.js';
import { MockTelegram } from '../src/mocks.js';
import { runFourMonitor } from '../src/four-monitor.js';

const product = { id: 'p1', name: 'Pokémon English', brand: 'pokemon', category: 'tcg', language: 'en', series: 'example', stock: 20, maxPerOrder: 2, globalLimit: 8 };
const accountId = i => `mock-account-${i}`;
const jobs = state => Object.values(state.multi.queue);
const quantities = state => Object.values(state.multi.accounts).map(a => a.cart['product:p1'] ?? 0);
async function setup(t, products = [product]) {
  const directory = await mkdtemp(fileURLToPath(new URL('../.test-four-', import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { store: new Store(directory), accounts: MOCK_ACCOUNTS, adapter: new MockAccountAdapter(),
    scanner: { scan: async () => products }, telegram: new MockTelegram(), log: () => {} };
}

test('Vier getrennte Sitzungen, Warenkörbe und Historien; genau ein Scan', async t => {
  const deps = await setup(t);
  let scans = 0;
  deps.scanner.scan = async () => { scans++; return [product, product]; };
  assert.equal((await runFourMonitor(deps)).completed, 4);
  const state = await deps.store.load();
  assert.equal(scans, 1);
  assert.equal(jobs(state).length, 4);
  assert.deepEqual(quantities(state), [2, 2, 2, 2]);
  assert.equal(new Set(Object.values(state.multi.accounts).map(a => a.session.token)).size, 4);
  for (const account of MOCK_ACCOUNTS) {
    const local = state.multi.accounts[account.id];
    assert.equal(local.session.accountId, account.id);
    assert.deepEqual(local.history.map(h => h.event), ['login_succeeded', 'cart_prepared', 'completed']);
  }
});
test('Genau vier erlaubte Mock-Konten sind zwingend', async t => {
  const deps = await setup(t);
  for (const accounts of [MOCK_ACCOUNTS.slice(0, 3), [...MOCK_ACCOUNTS, MOCK_ACCOUNTS[0]],
    [MOCK_ACCOUNTS[0], MOCK_ACCOUNTS[0], ...MOCK_ACCOUNTS.slice(2)],
    MOCK_ACCOUNTS.map(a => ({ ...a, mode: 'live' }))]) {
    await assert.rejects(runFourMonitor({ ...deps, accounts }), /Genau vier/);
  }
});
test('Ein Loginfehler isoliert ein Konto und wird beim nächsten Lauf erneut versucht', async t => {
  const deps = await setup(t);
  deps.adapter.loginFailures.add(accountId(2));
  const first = await runFourMonitor(deps);
  assert.equal(first.completed, 3);
  assert.equal(first.failed, 1);
  let state = await deps.store.load();
  assert.equal(state.multi.accounts[accountId(2)].session, null);
  assert.deepEqual(quantities(state), [2, 0, 2, 2]);
  assert.equal(state.multi.accounts[accountId(2)].lastError.stage, 'login');
  deps.adapter.loginFailures.clear();
  assert.equal((await runFourMonitor(deps)).completed, 1);
  state = await deps.store.load();
  assert.deepEqual(quantities(state), [2, 2, 2, 2]);
  assert.equal(state.multi.accounts[accountId(2)].lastError, null);
});
test('Globales Mengenbudget wird über vier Konten nie multipliziert', async t => {
  const deps = await setup(t, [{ ...product, globalLimit: 5 }]);
  const first = await runFourMonitor(deps);
  assert.equal(first.completed, 3);
  assert.equal(first.limited, 1);
  assert.deepEqual(quantities(await deps.store.load()), [2, 2, 1, 0]);
  await runFourMonitor(deps);
  assert.deepEqual(quantities(await deps.store.load()), [2, 2, 1, 0]);
});
test('Bestand und individuelle Kontolimits begrenzen die Gesamtzuteilung', async t => {
  const deps = await setup(t, [{ ...product, stock: 5, globalLimit: 10, accountLimits: { [accountId(1)]: 1, [accountId(2)]: 0 } }]);
  await runFourMonitor(deps);
  assert.deepEqual(quantities(await deps.store.load()), [1, 0, 2, 2]);
});
test('Fehlende oder ungültige globale Limits führen zu keiner Warenkorbaktion', async t => {
  for (const value of [undefined, -1, 1.5, Infinity]) {
    const deps = await setup(t, [{ ...product, globalLimit: value }]);
    const result = await runFourMonitor(deps);
    assert.equal(result.failed, 1);
    assert.equal(jobs(await deps.store.load()).length, 0);
  }
});
test('Warenkorbfehler verbraucht kein Budget und blockiert andere Konten nicht', async t => {
  const deps = await setup(t);
  deps.adapter.cartFailures.add(accountId(1));
  assert.equal((await runFourMonitor(deps)).failed, 1);
  let state = await deps.store.load();
  assert.deepEqual(quantities(state), [0, 2, 2, 2]);
  assert.equal(state.multi.accounts[accountId(1)].lastError.stage, 'cart');
  deps.adapter.cartFailures.clear();
  assert.equal((await runFourMonitor(deps)).completed, 1);
  state = await deps.store.load();
  assert.deepEqual(quantities(state), [2, 2, 2, 2]);
});
test('Telegramfehler hält Mengenbudget reserviert; kein erneuter Warenkorbaufruf', async t => {
  const deps = await setup(t, [{ ...product, globalLimit: 2 }]);
  deps.telegram.send = async () => { throw new Error('Mock-Zustellfehler'); };
  assert.equal((await runFourMonitor(deps)).failed, 1);
  assert.deepEqual(quantities(await deps.store.load()), [2, 0, 0, 0]);
  deps.telegram = new MockTelegram();
  deps.adapter.prepare = async () => { throw new Error('Keine Wiederholung erlaubt'); };
  assert.equal((await runFourMonitor(deps)).completed, 1);
  assert.deepEqual(quantities(await deps.store.load()), [2, 0, 0, 0]);
});
test('Persistente zentrale Queue verhindert Doppelverarbeitung nach Neustart', async t => {
  const deps = await setup(t);
  await runFourMonitor(deps);
  deps.store = new Store(deps.store.directory);
  deps.adapter.login = deps.adapter.prepare = deps.telegram.send = async () => { throw new Error('Doppelte Aktion'); };
  const second = await runFourMonitor(deps);
  assert.equal(second.completed, 0);
  assert.equal(second.failed, 0);
  assert.equal(jobs(await deps.store.load()).length, 4);
});
test('Zwei tatsächlich überlappende Läufe: zweiter Lauf wird vor dem Scan gesperrt', async t => {
  const deps = await setup(t);
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  deps.scanner.scan = async () => { entered(); await held; return [product]; };
  const first = runFourMonitor(deps);
  try {
    await started;
    await assert.rejects(runFourMonitor({ ...deps, store: new Store(deps.store.directory) }), { code: 'EEXIST' });
  } finally { release(); }
  assert.equal((await first).completed, 4);
});
test('Fremde Sitzungen werden nicht übernommen', async t => {
  const deps = await setup(t);
  deps.adapter.login = async () => ({ mode: 'mock', accountId: accountId(1) });
  const result = await runFourMonitor(deps);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 3);
  assert.deepEqual(quantities(await deps.store.load()), [2, 0, 0, 0]);
});
test('Englische Produkte werden für alle Konten vor deutschen Jubiläumsprodukten bearbeitet', async t => {
  const german = { ...product, id: 'de', language: 'de', series: '30-jahre-jubilaeum' };
  const deps = await setup(t, [german, product]);
  const seen = [];
  const original = deps.adapter.prepare.bind(deps.adapter);
  deps.adapter.prepare = async input => { seen.push(input.product.language); return original(input); };
  assert.equal((await runFourMonitor(deps)).completed, 8);
  assert.deepEqual(seen, ['en', 'en', 'en', 'en', 'de', 'de', 'de', 'de']);
});
test('Verfälschte Kontozuordnung im gespeicherten Zustand wird abgelehnt', async t => {
  const deps = await setup(t);
  await runFourMonitor(deps);
  const state = await deps.store.load();
  state.multi.accounts[accountId(2)].session.accountId = accountId(1);
  await writeFile(deps.store.path, JSON.stringify(state));
  await assert.rejects(runFourMonitor(deps), /Ungültiger Kontozustand/);
});

test('Nachträglich gesenktes Gesamtlimit blockiert weitere Aktionen', async t => {
  const deps = await setup(t);
  deps.telegram.send = async () => { throw new Error('Mock-Ausfall'); };
  await runFourMonitor(deps);
  deps.scanner.scan = async () => [{ ...product, globalLimit: 3 }];
  deps.telegram.send = async () => { throw new Error('Darf nicht senden'); };
  const result = await runFourMonitor(deps);
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);
  assert.deepEqual(quantities(await deps.store.load()), [2, 2, 2, 2]);
});

test('Ungültiges aktuelles Limit verwendet kein altes Mengenbudget', async t => {
  const deps = await setup(t);
  deps.adapter.cartFailures = new Set(MOCK_ACCOUNTS.map(a => a.id));
  await runFourMonitor(deps);
  deps.adapter.cartFailures.clear();
  deps.scanner.scan = async () => [{ ...product, globalLimit: undefined }];
  const result = await runFourMonitor(deps);
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 0);
  assert.deepEqual(quantities(await deps.store.load()), [0, 0, 0, 0]);
});

test('Loginfehler wird pro Konto nur einmal je Lauf versucht', async t => {
  const deps = await setup(t, [product, { ...product, id: 'p2' }]);
  deps.adapter.loginFailures.add(accountId(2));
  const result = await runFourMonitor(deps);
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 6);
  const local = (await deps.store.load()).multi.accounts[accountId(2)];
  assert.equal(local.history.filter(h => h.event === 'failed').length, 1);
});
