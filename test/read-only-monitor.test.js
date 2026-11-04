import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { runFourMonitor } from '../src/four-monitor.js';
import { MOCK_ACCOUNTS, MockAccountAdapter } from '../src/accounts.js';
import { BrackScanner } from '../src/brack/scanner.js';
import { TestLimitsPolicy } from '../src/brack/limits-policy.js';
import { TelegramPreview } from '../src/notification.js';
import { runLoop } from '../src/runner.js';
import { BrackHttp } from '../src/brack/http.js';
import { listing, rawProduct, NOW, EXPIRY } from './helpers/brack.js';

const quantities = state => Object.values(state.multi.accounts).map(a => a.cart['product:100001'] ?? 0);
const jobs = state => Object.values(state.multi.queue);
async function setup(t, products = [rawProduct()], policy = true) {
  const directory = await mkdtemp(fileURLToPath(new URL('../.test-read-only-', import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const limits = policy ? new TestLimitsPolicy({ version: 1, products: Object.fromEntries(products.map(p =>
    [p.sku, { maxPerOrder: 2, globalLimit: 5, expiresAt: EXPIRY }])) }) : null;
  return { store: new Store(directory), accounts: MOCK_ACCOUNTS, adapter: new MockAccountAdapter(),
    telegram: new TelegramPreview(), now: () => new Date(NOW), log: () => {},
    scanner: new BrackScanner({ now: () => new Date(NOW), policy: limits, http: { get: async () => listing(products) } }) };
}

test('Ohne bekannte Limits: Artikel und vier Aufträge bleiben dauerhaft offen, keine Aktion oder Meldung', async t => {
  const deps = await setup(t, [rawProduct(), rawProduct(100002, { breadcrumbs: [] })], false);
  deps.adapter.login = deps.adapter.prepare = deps.telegram.send = async () => assert.fail('Keine Aktion ohne Limits');
  const first = await runFourMonitor(deps);
  assert.equal(first.failed, 0);
  assert.equal(first.discovered, 1);
  assert.equal(first.limited, 1);
  const state = await deps.store.load();
  assert.equal(Object.keys(state.multi.observations).length, 2);
  assert.equal(state.multi.observations['100002'].selected, false);
  assert.match(state.multi.observations['100001'].blockedReason, /maxPerOrder/);
  assert.equal(jobs(state).length, 4);
  assert.ok(jobs(state).every(j => j.status === 'pending'));
  deps.store = new Store(deps.store.directory);
  assert.equal((await runFourMonitor(deps)).discovered, 0);
});

test('Vier isolierte Simulationen beachten gemeinsame Limits und erzeugen Telegram-Vorschauen nach Erfolg', async t => {
  const deps = await setup(t);
  const order = [];
  const prepare = deps.adapter.prepare.bind(deps.adapter);
  deps.adapter.prepare = async input => { order.push(input.account.id); return prepare(input); };
  assert.equal((await runFourMonitor(deps)).completed, 3);
  const state = await deps.store.load();
  assert.deepEqual(quantities(state), [2, 2, 1, 0]);
  assert.deepEqual(order, ['mock-account-1', 'mock-account-2', 'mock-account-3']);
  assert.equal(new Set(Object.values(state.multi.accounts).map(a => a.session.token)).size, 4);
  const notification = jobs(state)[0].notification;
  assert.equal(notification.delivery, 'preview-only');
  assert.match(notification.message, /Produkt: Pokémon English Booster/);
  assert.match(notification.message, /Menge: 2/);
  assert.match(notification.message, /Konto: mock-account-1/);
  assert.match(notification.message, /https:\/\/www.brack.ch\/pokemon-english-booster-100001/);
  assert.equal(notification.payload.text, notification.message);
  assert.equal(notification.payload.chat_id, undefined);
  deps.store = new Store(deps.store.directory);
  deps.adapter.prepare = deps.telegram.send = async () => assert.fail('Doppelte Aktion');
  const restarted = await runFourMonitor(deps);
  assert.equal(restarted.completed, 0);
  assert.equal(restarted.failed, 0);
  assert.deepEqual(quantities(await deps.store.load()), [2, 2, 1, 0]);
});

test('Englische Treffer haben Vorrang vor deutschen Jubiläumstreffern; andere werden ignoriert', async t => {
  const german = rawProduct(100002, { description: { nameWithoutManufacturer: '30 Jahre Jubiläum', shortTextList: ['Sprache: Deutsch'] } });
  const other = rawProduct(100003, { description: { nameWithoutManufacturer: 'Deutsch', shortTextList: ['Sprache: Deutsch'] } });
  const deps = await setup(t, [german, other, rawProduct()]);
  const order = [];
  const prepare = deps.adapter.prepare.bind(deps.adapter);
  deps.adapter.prepare = async input => { order.push(input.product.language); return prepare(input); };
  assert.equal((await runFourMonitor(deps)).discovered, 2);
  assert.deepEqual(order, ['en', 'en', 'en', 'de', 'de', 'de']);
});

test('Fehlender neuer Scan oder verschwundener Artikel darf gespeicherte Pläne nicht neu vorbereiten', async t => {
  const deps = await setup(t);
  deps.adapter.prepare = async () => { throw new Error('Testfehler vor Vorbereitung'); };
  await runFourMonitor(deps);
  deps.adapter.prepare = async () => assert.fail('Keine veraltete Vorbereitung');
  deps.scanner.http.get = async () => { throw new Error('offline'); };
  const offline = await runFourMonitor(deps);
  assert.equal(offline.failed, 1);
  assert.equal(offline.completed, 0);
  deps.scanner.http.get = async () => listing([]);
  const disappeared = await runFourMonitor(deps);
  assert.equal(disappeared.completed, 0);
  assert.equal(disappeared.failed, 0);
  assert.deepEqual(quantities(await deps.store.load()), [0, 0, 0, 0]);
});

test('Veraltete, zukünftige und abgelaufene Schnappschüsse lösen keine Vorbereitung aus', async t => {
  for (const time of ['2026-11-02T11:58:00.000Z', '2026-11-02T12:01:00.000Z']) {
    const deps = await setup(t);
    deps.scanner.now = () => new Date(time);
    deps.adapter.prepare = async () => assert.fail('Veraltete Daten');
    const result = await runFourMonitor(deps);
    assert.equal(result.completed, 0);
    assert.equal(result.failed, 0);
  }
  const deps = await setup(t);
  deps.scanner.policy.products['100001'].expiresAt = NOW;
  deps.adapter.prepare = async () => assert.fail('Abgelaufene Limits');
  const expired = await runFourMonitor(deps);
  assert.equal(expired.completed, 0);
  assert.equal(expired.failed, 0);
});

test('Limitablauf während eines Laufs blockiert spätere Konten', async t => {
  const deps = await setup(t);
  let current = new Date(NOW);
  deps.now = () => current;
  deps.scanner.policy.products['100001'].expiresAt = '2026-11-02T12:00:01.000Z';
  const prepare = deps.adapter.prepare.bind(deps.adapter);
  deps.adapter.prepare = async input => { const result = await prepare(input); current = new Date('2026-11-02T12:00:02.000Z'); return result; };
  const result = await runFourMonitor(deps);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(quantities(await deps.store.load()), [2, 0, 0, 0]);
});

test('Unbekannte aktuelle Limits verwenden keine früher gespeicherten gültigen Werte', async t => {
  const deps = await setup(t);
  deps.adapter.prepare = async () => { throw new Error('Simulation vor Erfolg fehlgeschlagen'); };
  await runFourMonitor(deps);
  deps.scanner.policy = null;
  deps.adapter.prepare = async () => assert.fail('Keine alten Limits');
  const result = await runFourMonitor(deps);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
  assert.equal((await deps.store.load()).multi.products['100001'].globalLimit, null);
});

test('Nachrichten-Wiederholung nutzt den bestätigten Produktsnapshot und ruft den Warenkorb nicht erneut auf', async t => {
  const deps = await setup(t);
  deps.telegram.send = async () => { throw new Error('Preview vor Speicherung fehlgeschlagen'); };
  await runFourMonitor(deps);
  deps.scanner.http.get = async () => { throw new Error('Scanner offline'); };
  deps.telegram = new TelegramPreview();
  deps.adapter.prepare = async () => assert.fail('Keine doppelte Warenkorbaktion');
  const result = await runFourMonitor(deps);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 1); // Only the scanner is offline.
  assert.ok(jobs(await deps.store.load()).filter(j => j.status === 'done').every(j => j.notification.message.includes('Pokémon English Booster')));
});

test('Unvollständige Scans veröffentlichen keine Teilprodukte; Zugriffsschutz beendet automatische Läufe', async t => {
  const deps = await setup(t);
  deps.scanner.http.get = async () => listing([rawProduct()], { total: 2 });
  assert.equal((await runFourMonitor(deps)).failed, 1);
  assert.equal(jobs(await deps.store.load()).length, 0);
  deps.scanner.http.get = async () => '<title>CAPTCHA</title>';
  assert.equal((await runFourMonitor(deps)).halted, true);
});

test('Sperre umfasst auch echte Lesescans; Offline- und Lesezustände bleiben getrennt', async t => {
  const deps = await setup(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  deps.scanner.http.get = async () => { entered(); await held; return listing(); };
  const first = runFourMonitor(deps);
  try {
    await started;
    await assert.rejects(runFourMonitor({ ...deps, store: new Store(deps.store.directory) }), { code: 'EEXIST' });
  } finally { release(); }
  await first;
  await assert.rejects(runFourMonitor({ ...deps, scanner: { scan: async () => [] } }), /Getrennten Zustand/);
});

test('Scheduler wartet auf jeden Scan, reagiert auf Abbruch und stoppt bei Zugriffsschutz', async () => {
  let calls = 0;
  const abort = new AbortController();
  const result = await runLoop({ watch: true, signal: abort.signal,
    run: async () => { calls++; return { completed: calls }; },
    sleep: async () => { assert.equal(calls, 1); abort.abort(); } });
  assert.equal(result.completed, 1);
  await runLoop({ watch: true, run: async () => ({ halted: true }), sleep: async () => assert.fail('Zugriffsschutz muss stoppen') });
  await assert.rejects(runLoop({ run: async () => {}, intervalMs: 1000 }), /30 Sekunden/);
});

test('Retry-After über dem HTTP-Wartelimit verschiebt auch den nächsten geplanten Scan', async t => {
  const deps = await setup(t);
  deps.scanner.http = new BrackHttp({ fetchImpl: async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    sleep: async () => assert.fail('Kein sofortiger HTTP-Retry') });
  const abort = new AbortController();
  await runLoop({ watch: true, signal: abort.signal, run: () => runFourMonitor(deps),
    sleep: async ms => { assert.equal(ms, 120000); abort.abort(); } });
});

test('Nach langsamer Sitzungserstellung werden Bestand und Limitablauf nochmals geprüft', async t => {
  const deps = await setup(t);
  let current = new Date(NOW);
  deps.now = () => current;
  const login = deps.adapter.login.bind(deps.adapter);
  deps.adapter.login = async account => { current = new Date('2026-11-02T12:02:00.000Z'); return login(account); };
  deps.adapter.prepare = async () => assert.fail('Keine Vorbereitung nach Datenablauf');
  const result = await runFourMonitor(deps);
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 0);
  assert.deepEqual(quantities(await deps.store.load()), [0, 0, 0, 0]);
});

test('Beschädigte gespeicherte Vorbereitung wird abgewiesen und nicht überschrieben', async t => {
  const deps = await setup(t);
  await runFourMonitor(deps);
  const state = await deps.store.load();
  jobs(state)[0].preparedProduct.id = '999999';
  const damaged = JSON.stringify(state);
  await writeFile(deps.store.path, damaged);
  await assert.rejects(runFourMonitor(deps), /Ungültige gespeicherte Vorbereitung/);
  assert.equal(await readFile(deps.store.path, 'utf8'), damaged);
});
