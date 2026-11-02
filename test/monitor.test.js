import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { MockScanner, MockCart, MockTelegram } from '../src/mocks.js';
import { runMonitor } from '../src/monitor.js';
import { priority, quantityPlan } from '../src/filter.js';

const en = { id: 'en', name: 'English', brand: 'pokemon', category: 'tcg', language: 'en', series: 'x', stock: 10, maxPerOrder: 4, existingQuantity: 1 };
const de = { ...en, id: 'de', name: 'Deutsch', language: 'de', series: '30-jahre-jubilaeum' };
async function setup(t) {
  const dir = await mkdtemp(fileURLToPath(new URL('../.test-', import.meta.url)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { store: new Store(dir), scanner: { scan: async () => [en] }, cart: new MockCart(), telegram: new MockTelegram(), log: () => {} };
}

test('Filter priorisiert englisches TCG und akzeptiert deutsches Jubiläum', () => {
  assert.equal(priority(en), 2);
  assert.equal(priority(de), 1);
  assert.equal(priority({ ...de, series: 'other' }), 0);
  assert.equal(priority({ ...en, category: 'toy' }), 0);
  assert.equal(priority({ ...en, brand: 'other' }), 0);
});
test('Menge berücksichtigt Bestand, Limit und vorhandene Position', () => {
  assert.deepEqual(quantityPlan(en), { targetQuantity: 4, existingQuantity: 1, addQuantity: 3 });
  assert.equal(quantityPlan({ ...en, stock: 2 }).targetQuantity, 2);
  for (const value of [undefined, NaN, Infinity, -1, 1.5]) {
    assert.throws(() => quantityPlan({ ...en, maxPerOrder: value }));
  }
  assert.throws(() => quantityPlan({ ...en, existingQuantity: 5 }));
});
test('Fixtures bleiben offline; englische Produkte werden zuerst vorbereitet', async t => {
  const deps = await setup(t);
  deps.scanner = new MockScanner();
  const order = [];
  deps.cart = { prepare: async (p, options) => { order.push(p.language); return new MockCart().prepare(p, options); } };
  const result = await runMonitor(deps);
  assert.deepEqual(order, ['en', 'de']);
  assert.equal(result.completed, 2);
  assert.equal(result.ignored, 1);
});
test('Persistenz verhindert doppelte Verarbeitung auch nach neuem Store', async t => {
  const deps = await setup(t);
  deps.scanner.scan = async () => [en, en];
  assert.equal((await runMonitor(deps)).completed, 1);
  deps.store = new Store(deps.store.directory);
  deps.cart.prepare = async () => { throw new Error('darf nicht aufgerufen werden'); };
  const second = await runMonitor(deps);
  assert.equal(second.completed, 0);
  assert.equal(second.failed, 0);
});
test('Telegram-Fehler wird wiederholt ohne erneute Warenkorbvorbereitung', async t => {
  const deps = await setup(t);
  let prepares = 0;
  deps.cart = { prepare: async (p, options) => { prepares++; return new MockCart().prepare(p, options); } };
  deps.telegram.send = async () => { throw new Error('simulierter Telegram-Ausfall'); };
  assert.equal((await runMonitor(deps)).failed, 1);
  assert.equal((await deps.store.load()).products['product:en'].status, 'prepared');
  deps.telegram = new MockTelegram();
  assert.equal((await runMonitor(deps)).completed, 1);
  assert.equal(prepares, 1);
});
test('Fehler eines Produkts blockiert das nächste nicht; Bestand wird erneut übernommen', async t => {
  const deps = await setup(t);
  deps.scanner.scan = async () => [{ ...en, stock: 0, existingQuantity: 0 }, de];
  const first = await runMonitor(deps);
  assert.equal(first.failed, 1);
  assert.equal(first.completed, 1);
  deps.scanner.scan = async () => [en];
  assert.equal((await runMonitor(deps)).completed, 1);
});
test('Ausstehende Meldung wird trotz Scanner-Ausfall zugestellt', async t => {
  const deps = await setup(t);
  deps.telegram.send = async () => { throw new Error('offline'); };
  await runMonitor(deps);
  deps.scanner.scan = async () => { throw new Error('Scanner offline'); };
  deps.telegram = new MockTelegram();
  const result = await runMonitor(deps);
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
});
test('Beschädigter Zustand wird nicht stillschweigend überschrieben', async t => {
  const deps = await setup(t);
  await writeFile(deps.store.path, '{broken');
  await assert.rejects(runMonitor(deps));
  assert.equal(await readFile(deps.store.path, 'utf8'), '{broken');
});
test('Ungültiges Zustandsschema und Produkte werden erkannt', async t => {
  const deps = await setup(t);
  await writeFile(deps.store.path, 'null');
  await assert.rejects(runMonitor(deps), /Ungültiger Zustand/);
  await writeFile(deps.store.path, JSON.stringify({ version: 1, products: {} }));
  deps.scanner.scan = async () => [null, en];
  const result = await runMonitor(deps);
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 1);
});
test('Exklusive Sperre verhindert überlappende Verarbeitung', async t => {
  const deps = await setup(t);
  await deps.store.locked(async () => {
    await assert.rejects(runMonitor(deps), { code: 'EEXIST' });
  });
  assert.equal((await runMonitor(deps)).completed, 1);
});
test('Zustandsablage ausserhalb des Projekts ist verboten', () => {
  assert.throws(() => new Store('/tmp/external-brack-state'), /innerhalb/);
});
