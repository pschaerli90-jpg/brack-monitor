import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { BrackScanner } from '../src/brack/scanner.js';
import { runDiscoveryMonitor } from '../src/telegram/outbox.js';
import { TelegramDeliveryError, TelegramClient } from '../src/telegram/client.js';
import { SimulatedTelegramDelivery } from '../src/telegram/message.js';
import { listing, rawProduct } from './helpers/brack.js';

async function setup(t, products = [rawProduct()]) {
  const directory = await mkdtemp(fileURLToPath(new URL('../.test-telegram-outbox-', import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = new Date('2026-11-03T12:00:00.000Z');
  const calls = [], logs = [];
  const deps = { store: new Store(directory), source: 'fixture', now: () => time, random: () => 0,
    scanner: new BrackScanner({ now: () => time, http: { get: async () => listing(products) } }),
    telegram: new SimulatedTelegramDelivery(), log: event => logs.push(event) };
  const send = deps.telegram.send.bind(deps.telegram);
  deps.telegram.send = async text => { calls.push(text); return send(text); };
  return { deps, calls, logs, advance: ms => { time = new Date(time.getTime() + ms); },
    entries: async () => (await deps.store.load()).discovery.entries };
}

test('Alle passenden Sprachen werden ohne Priorität und Mengenlimits einmal pro Artikel gemeldet', async t => {
  const german = rawProduct(100002, { description: { nameWithoutManufacturer: '30 Jahre Jubiläum', shortTextList: ['Sprache: Deutsch'] } });
  const other = rawProduct(100003, { description: { nameWithoutManufacturer: 'Deutsch', shortTextList: ['Sprache: Deutsch'] } });
  const s = await setup(t, [german, other, rawProduct()]);
  const result = await runDiscoveryMonitor(s.deps);
  assert.equal(result.simulated, 3);
  assert.equal(result.discovered, 3);
  assert.match(s.calls[0], /Sprache: Deutsch/);
  assert.match(s.calls[1], /Sprache: Deutsch/);
  assert.equal(Object.keys(await s.entries()).length, 3);
  const state = await s.deps.store.load();
  assert.equal(state.multi, undefined); // No sessions or cart jobs participate in delivery.
  assert.deepEqual(state.products, {});
  assert.equal((await s.entries())['100001'].product.maxPerOrder, undefined);
});

test('Kein Lagerbestand und unbekannter Lagerbestand verhindern eine Produktmeldung nicht', async t => {
  const s = await setup(t, [rawProduct(100001, { inventory: { current: 0 } }), rawProduct(100002, { inventory: {} })]);
  const result = await runDiscoveryMonitor(s.deps);
  assert.equal(result.simulated, 2);
  assert.equal(result.failed, 0);
  assert.match(s.calls[0], /Erkennung\): 0/);
  assert.match(s.calls[1], /Erkennung\): unbekannt/);
});

test('Gleiche Artikelnummer bleibt nach Wiederholung, Titeländerung und Store-Neustart erledigt', async t => {
  const s = await setup(t);
  await runDiscoveryMonitor(s.deps);
  s.deps.store = new Store(s.deps.store.directory);
  s.deps.scanner.http.get = async () => listing([rawProduct(100001, { description: { nameWithoutManufacturer: 'Changed title', shortTextList: ['Sprache: Englisch'] } })]);
  const result = await runDiscoveryMonitor(s.deps);
  assert.equal(result.simulated, 0);
  assert.equal(result.discovered, 0);
  assert.equal(s.calls.length, 1);
  assert.equal((await s.entries())['100001'].product.name, 'Pokémon English Booster');
});

test('Bekannte Ablehnung: Backoff und globale Telegram-Pause überleben Neustart und schützen weitere Produkte', async t => {
  const s = await setup(t, [rawProduct(), rawProduct(100002)]);
  let attempts = 0;
  s.deps.telegram.send = async () => { attempts++; throw new TelegramDeliveryError('rate_limited', 'retry', 120000); };
  const first = await runDiscoveryMonitor(s.deps);
  assert.equal(first.telegramRetryAfterMs, 120000);
  assert.equal(first.retryAfterMs, undefined);
  assert.equal(attempts, 1);
  s.deps.store = new Store(s.deps.store.directory);
  s.advance(60000);
  s.deps.scanner.http.get = async () => listing([rawProduct(), rawProduct(100002), rawProduct(100003)]);
  assert.equal((await runDiscoveryMonitor(s.deps)).discovered, 1);
  assert.equal(attempts, 1);
  s.advance(60001);
  s.deps.telegram.send = async () => { attempts++; return { mode: 'test', simulated: true }; };
  const recovered = await runDiscoveryMonitor(s.deps);
  assert.equal(recovered.simulated, 3);
  assert.equal(attempts, 4);
  assert.equal((await s.entries())['100001'].attempts, 2);
  assert.equal((await s.entries())['100002'].attempts, 1);
});

test('Versuchsgrenze und manuelle Wiederholung gelten nur für bestätigte Nichtzustellung', async t => {
  const s = await setup(t);
  s.deps.maxAttempts = 2;
  let calls = 0;
  s.deps.telegram.send = async () => { calls++; throw new TelegramDeliveryError('network_before_send', 'retry'); };
  await runDiscoveryMonitor(s.deps);
  s.advance(60000);
  await runDiscoveryMonitor(s.deps);
  assert.equal((await s.entries())['100001'].status, 'failed');
  s.advance(60000);
  await runDiscoveryMonitor(s.deps);
  assert.equal(calls, 2);
  s.deps.telegram.send = async () => { calls++; return { mode: 'test', simulated: true }; };
  assert.equal((await runDiscoveryMonitor({ ...s.deps, retryFailed: '100001' })).simulated, 1);
  assert.equal(calls, 3);
  assert.ok((await s.entries())['100001'].retriedManuallyAt);
});

test('Timeout oder unerwarteter Fehler führt zu unklarer Zustellung und niemals automatischem Nachsenden', async t => {
  const s = await setup(t);
  let calls = 0;
  s.deps.telegram.send = async () => { calls++; throw new Error('Secret-like transport URL'); };
  const result = await runDiscoveryMonitor(s.deps);
  assert.equal(result.uncertain, 1);
  assert.equal(result.held, 1);
  await runDiscoveryMonitor(s.deps);
  assert.equal(calls, 1);
  await assert.rejects(runDiscoveryMonitor({ ...s.deps, retryFailed: '100001' }), /bestätigte/);
  await runDiscoveryMonitor({ ...s.deps, acknowledgeUncertain: '100001' });
  assert.equal((await s.entries())['100001'].status, 'sent');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(s.logs).includes('Secret-like'));
});

test('Absturzfenster nach POST-Erfolg und vor Speicherung wird beim Neustart angehalten', async t => {
  const s = await setup(t);
  const save = s.deps.store.save.bind(s.deps.store);
  let saves = 0;
  s.deps.store.save = async state => { saves++; if (saves === 3) throw new Error('Simulated disk failure'); return save(state); };
  await assert.rejects(runDiscoveryMonitor(s.deps), /disk failure/);
  assert.equal(s.calls.length, 1);
  assert.equal((await s.entries())['100001'].status, 'sending');
  s.deps.store = new Store(s.deps.store.directory);
  const restarted = await runDiscoveryMonitor(s.deps);
  assert.equal(restarted.held, 1);
  assert.equal(s.calls.length, 1);
  assert.equal((await s.entries())['100001'].lastError, 'delivery_unknown_after_restart');
});

test('Fehlgeschlagene Speicherung vor dem POST löst keine Zustellung aus und bleibt wiederholbar', async t => {
  const s = await setup(t);
  const save = s.deps.store.save.bind(s.deps.store);
  let saves = 0;
  s.deps.store.save = async state => { saves++; if (saves === 2) throw new Error('Before POST'); return save(state); };
  await assert.rejects(runDiscoveryMonitor(s.deps), /Before POST/);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.entries())['100001'].status, 'pending');
  s.deps.store = new Store(s.deps.store.directory);
  assert.equal((await runDiscoveryMonitor(s.deps)).simulated, 1);
  assert.equal(s.calls.length, 1);
});

test('Bereits wartende Meldung wird auch bei Scanner-Ausfall sicher wiederholt', async t => {
  const s = await setup(t);
  s.deps.telegram.send = async () => { throw new TelegramDeliveryError('network_before_send', 'retry'); };
  await runDiscoveryMonitor(s.deps);
  s.advance(60000);
  s.deps.telegram = new SimulatedTelegramDelivery();
  s.deps.scanner.http.get = async () => { throw new Error('BRACK unavailable'); };
  const result = await runDiscoveryMonitor(s.deps);
  assert.equal(result.failed, 1);
  assert.equal(result.simulated, 1);
});

test('Paralleler Prozess wird vor Scan und Zustellung durch dieselbe Zustandssperre abgewiesen', async t => {
  const s = await setup(t);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let calls = 0;
  s.deps.telegram.send = async () => { calls++; entered(); await held; return { mode: 'test', simulated: true }; };
  const first = runDiscoveryMonitor(s.deps);
  try {
    await started;
    await assert.rejects(runDiscoveryMonitor({ ...s.deps, store: new Store(s.deps.store.directory) }), { code: 'EEXIST' });
  } finally { release(); }
  await first;
  assert.equal(calls, 1);
});

test('Baseline unterdrückt nur den ersten Bestand; später neue Artikel werden zugestellt', async t => {
  const s = await setup(t);
  assert.equal((await runDiscoveryMonitor({ ...s.deps, baseline: true })).simulated, 0);
  assert.equal((await s.entries())['100001'].status, 'suppressed');
  s.deps.scanner.http.get = async () => listing([rawProduct(), rawProduct(100002)]);
  assert.equal((await runDiscoveryMonitor(s.deps)).simulated, 1);
  await assert.rejects(runDiscoveryMonitor({ ...s.deps, baseline: true }), /ersten erfolgreichen Scan/);
  assert.equal(s.calls.length, 1);
});

test('Test-/Echtbetrieb, Quellen und frühere Warenkorbzustände dürfen nicht vermischt werden', async t => {
  const s = await setup(t);
  await runDiscoveryMonitor(s.deps);
  const before = await readFile(s.deps.store.path, 'utf8');
  await assert.rejects(runDiscoveryMonitor({ ...s.deps, source: 'brack' }), /inkompatibler/);
  await assert.rejects(runDiscoveryMonitor({ ...s.deps, telegram: { mode: 'telegram' } }), /Benachrichtigungsmodus/);
  await assert.rejects(runDiscoveryMonitor({ ...s.deps, source: 'brack', telegram: { mode: 'telegram' } }), /inkompatibler/);
  assert.equal(await readFile(s.deps.store.path, 'utf8'), before);
  const state = await s.deps.store.load();
  state.multi = {};
  await writeFile(s.deps.store.path, JSON.stringify(state));
  await assert.rejects(runDiscoveryMonitor(s.deps), /Separaten Zustand/);
});

test('Beschädigte Outbox wird nicht überschrieben und ungültige Teilscans erzeugen keine Meldung', async t => {
  const s = await setup(t);
  s.deps.scanner.http.get = async () => listing([rawProduct()], { total: 2 });
  assert.equal((await runDiscoveryMonitor(s.deps)).failed, 1);
  assert.equal(s.calls.length, 0);
  s.deps.scanner.http.get = async () => listing();
  await runDiscoveryMonitor(s.deps);
  const state = await s.deps.store.load();
  state.discovery.entries['100001'].attempts = -1;
  const damaged = JSON.stringify(state);
  await writeFile(s.deps.store.path, damaged);
  await assert.rejects(runDiscoveryMonitor(s.deps), /Ungültiger gespeicherter/);
  assert.equal(await readFile(s.deps.store.path, 'utf8'), damaged);
});

test('Echter Client integriert mit Outbox: Nachrichtenquittung wird gespeichert, Geheimnisse nicht', async t => {
  const s = await setup(t);
  const token = '123456789:' + 'x'.repeat(35), chatId = '-1001234567890';
  s.deps.source = 'brack';
  let posts = 0;
  s.deps.telegram = new TelegramClient({ botToken: token, chatId }, { fetchImpl: async () => {
    posts++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 77, chat: { id: Number(chatId) } } }), { headers: { 'content-type': 'application/json' } });
  } });
  assert.equal((await runDiscoveryMonitor(s.deps)).sent, 1);
  await runDiscoveryMonitor(s.deps);
  assert.equal(posts, 1);
  const saved = await readFile(s.deps.store.path, 'utf8');
  assert.deepEqual((await s.entries())['100001'].receipt, { mode: 'telegram', messageId: 77 });
  for (const content of [saved, JSON.stringify(s.logs)]) {
    assert.ok(!content.includes(token)); assert.ok(!content.includes(chatId));
  }
});

test('Zugriffsschutz sowie Authentifizierungsfehler stoppen automatische Läufe', async t => {
  const s = await setup(t);
  s.deps.scanner.http.get = async () => '<title>CAPTCHA</title>';
  assert.equal((await runDiscoveryMonitor(s.deps)).halted, true);
  s.deps.scanner.http.get = async () => listing([rawProduct(), rawProduct(100002)]);
  let calls = 0;
  s.deps.telegram.send = async () => { calls++; throw new TelegramDeliveryError('unauthorized', 'permanent'); };
  const result = await runDiscoveryMonitor(s.deps);
  assert.equal(result.halted, true);
  assert.equal(calls, 1);
  assert.equal((await s.entries())['100001'].status, 'failed');
  assert.equal((await s.entries())['100002'].status, 'pending');
});

test('Telegram-Pause gilt nach ausgeschöpften Versuchen auch für andere Artikel', async t => {
  const s = await setup(t, [rawProduct(), rawProduct(100002)]);
  s.deps.maxAttempts = 1;
  let calls = 0;
  s.deps.telegram.send = async () => { calls++; throw new TelegramDeliveryError('rate_limited', 'retry', 120000); };
  const first = await runDiscoveryMonitor(s.deps);
  assert.equal(first.telegramRetryAfterMs, 120000);
  assert.equal((await s.entries())['100001'].status, 'failed');
  assert.equal((await s.entries())['100002'].attempts, 0);
  s.advance(60000);
  await runDiscoveryMonitor(s.deps);
  assert.equal(calls, 1);
});

function legacyEntry(p, status = 'sent') {
  const firstSeenAt = '2026-11-03T12:00:00.000Z';
  const text = 'Neues BRACK Pokémon-TCG-Produkt\nProdukt: ' + p.name + '\nArtikelnummer: ' + p.id +
    '\nSprache: Englisch\nLagerbestand (bei Erkennung): 12\nLink: ' + p.url + '\nErkannt am: ' + firstSeenAt;
  return { product: p, text, firstSeenAt, nextAttemptAt: firstSeenAt, status, attempts: 1,
    ...(status === 'sent' ? { sentAt: firstSeenAt, receipt: { mode: 'test', simulated: true } } : {}) };
}

test('Migration von v1 meldet weder bekannte EN noch neu berechtigte DE/FR-Bestandsartikel erneut', async t => {
  const s = await setup(t);
  const p = (await s.deps.scanner.scan())[0];
  delete p.imageUrl;
  const entry = legacyEntry(p);
  await s.deps.store.save({ version: 1, products: {}, discovery: { version: 1, mode: 'test', source: 'fixture',
    initialScanAt: entry.firstSeenAt, pausedUntil: null, entries: { [p.id]: entry } } });
  const fr = rawProduct(100002, { description: { nameWithoutManufacturer: 'Français', shortTextList: ['Sprache: Französisch'] } });
  const de = rawProduct(100003, { description: { nameWithoutManufacturer: 'Deutsch', shortTextList: ['Sprache: Deutsch'] } });
  s.deps.scanner.http.get = async () => listing([rawProduct(), fr, de]);
  assert.equal((await runDiscoveryMonitor(s.deps)).simulated, 0);
  const state = await s.deps.store.load();
  assert.equal(state.discovery.version, 2);
  assert.equal(state.discovery.entries['100001'].attempts, 1);
  assert.deepEqual(state.discovery.entries['100001'].receipt, entry.receipt);
  assert.equal(state.discovery.entries['100002'].status, 'suppressed');
  assert.equal(state.discovery.entries['100003'].status, 'suppressed');
  s.deps.store = new Store(s.deps.store.directory);
  s.deps.scanner.http.get = async () => listing([rawProduct(), fr, de, rawProduct(100004)]);
  assert.equal((await runDiscoveryMonitor(s.deps)).simulated, 1);
  assert.equal(s.calls.length, 1);
  assert.match(s.calls[0], /100004/);
  assert.ok(!s.calls[0].includes('Erkannt am'));
});

test('Gescheiterter Scan beendet die Migrationsbaseline nicht und unklare Zustellung bleibt angehalten', async t => {
  const s = await setup(t), p = (await s.deps.scanner.scan())[0];
  const entry = legacyEntry(p, 'sending');
  entry.attemptStartedAt = entry.firstSeenAt;
  await s.deps.store.save({ version: 1, products: {}, discovery: { version: 1, mode: 'test', source: 'fixture',
    initialScanAt: entry.firstSeenAt, pausedUntil: null, entries: { [p.id]: entry } } });
  s.deps.scanner.http.get = async () => { throw new Error('synthetic scan failure'); };
  await runDiscoveryMonitor(s.deps);
  assert.equal((await s.deps.store.load()).discovery.needsBaseline, true);
  s.deps.scanner.http.get = async () => listing([rawProduct(), rawProduct(100002)]);
  await runDiscoveryMonitor(s.deps);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.entries())['100001'].status, 'uncertain');
  assert.equal((await s.entries())['100002'].status, 'suppressed');
});

test('Fehlendes Bild bleibt ohne Telegram-Versuch vorgemerkt und wird später einmal mit echtem Bild gemeldet', async t => {
  const s = await setup(t, [rawProduct(100001, { images: [] })]);
  await runDiscoveryMonitor(s.deps);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.entries())['100001'].attempts, 0);
  assert.equal((await s.entries())['100001'].blockedReason, 'image_missing');
  const before = (await s.entries())['100001'].firstSeenAt;
  let image;
  s.deps.telegram.send = async (text, options) => { image = options.imageUrl; s.calls.push(text); return { mode: 'test', simulated: true }; };
  s.deps.scanner.http.get = async () => listing();
  await runDiscoveryMonitor(s.deps);
  await runDiscoveryMonitor(s.deps);
  assert.equal(s.calls.length, 1);
  assert.ok(image.startsWith('https://assets.brack.ch/images2/'));
  assert.equal((await s.entries())['100001'].firstSeenAt, before);
  assert.ok(s.logs.some(e => e.event === 'discovery_product_detected' && e.firstSeenAt === before));
});

test('Sprachen haben gleiche Behandlung in Scanreihenfolge; andere Marken/Sprachen bleiben ausgeschlossen', async t => {
  const lang = (id, language) => rawProduct(id, { description: { nameWithoutManufacturer: language, shortTextList: ['Sprache: ' + language] } });
  const s = await setup(t, [lang(100003, 'Französisch'), lang(100002, 'Deutsch'), rawProduct(), lang(100004, 'Japanisch'),
    rawProduct(100005, { manufacturer: { name: 'other' }, description: { nameWithoutManufacturer: 'other', shortTextList: ['Sprache: Englisch'] } })]);
  await runDiscoveryMonitor(s.deps);
  assert.equal(s.calls.length, 3);
  assert.match(s.calls[0], /Französisch \(FR\)/);
  assert.match(s.calls[1], /Deutsch \(DE\)/);
  assert.match(s.calls[2], /Englisch \(EN\)/);
  const firstSeenAt = (await s.entries())['100003'].firstSeenAt;
  assert.ok(firstSeenAt);
  assert.ok(s.calls.every(text => !text.includes(firstSeenAt)));
});

test('Bereits beobachtete zuvor ausgeschlossene Artikel werden bei Sprachänderung nicht neu gemeldet', async t => {
  const s = await setup(t, [rawProduct(100001, { description: { nameWithoutManufacturer: 'JP', shortTextList: ['Sprache: Japanisch'] } })]);
  await runDiscoveryMonitor(s.deps);
  s.deps.scanner.http.get = async () => listing();
  await runDiscoveryMonitor(s.deps);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.entries())['100001'].status, 'suppressed');
});

test('Beschädigter v1-Nachrichtentext wird nicht als gültige Migration übernommen', async t => {
  const s = await setup(t), p = (await s.deps.scanner.scan())[0];
  const entry = legacyEntry(p); entry.text += 'tampered';
  const state = { version: 1, products: {}, discovery: { version: 1, mode: 'test', source: 'fixture',
    initialScanAt: entry.firstSeenAt, pausedUntil: null, entries: { [p.id]: entry } } };
  await s.deps.store.save(state);
  const before = await readFile(s.deps.store.path, 'utf8');
  await assert.rejects(runDiscoveryMonitor(s.deps), /Ungültiger gespeicherter/);
  assert.equal(await readFile(s.deps.store.path, 'utf8'), before);
  assert.equal(s.calls.length, 0);
});

test('Vorübergehend ungültiges neues Produkt wird nach Datenkorrektur noch erstmals gemeldet', async t => {
  const s = await setup(t), p = (await s.deps.scanner.scan())[0];
  s.deps.scanner.scan = async () => [{ ...p, stock: -1 }];
  await runDiscoveryMonitor(s.deps);
  assert.equal(s.calls.length, 0);
  s.deps.scanner.scan = async () => [p];
  await runDiscoveryMonitor(s.deps);
  assert.equal(s.calls.length, 1);
});

test('Langer früher gültiger Name blockiert die Migration einer bereits zugestellten Nachricht nicht', async t => {
  const s = await setup(t), p = (await s.deps.scanner.scan())[0];
  p.name = 'x'.repeat(2000);
  const entry = legacyEntry(p);
  await s.deps.store.save({ version: 1, products: {}, discovery: { version: 1, mode: 'test', source: 'fixture',
    initialScanAt: entry.firstSeenAt, pausedUntil: null, entries: { [p.id]: entry } } });
  await runDiscoveryMonitor(s.deps);
  assert.equal(s.calls.length, 0);
  assert.equal((await s.entries())['100001'].product.name.length, 2000);
  assert.ok((await s.entries())['100001'].text.length <= 1024);
});
