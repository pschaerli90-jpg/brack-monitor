import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../src/runner.js';
import { runFourMonitor } from '../src/four-monitor.js';
import { TelegramDeliveryError } from '../src/telegram/client.js';
import { accountSetup } from './helpers/accounts.js';
import { rawProduct } from './helpers/brack.js';

const puts = s => s.requests.filter(r => r.method === 'PUT');
const jobs = async s => (await s.state()).realCarts.products['100001'].jobs;

test('Gemeinsamer Scan startet Konto-Lesen und Meldung vor der nächsten 30-Sekunden-Pause', async t => {
  const s = await accountSetup(t), abort = new AbortController();
  await s.locked(() => runLoop({ watch: true, intervalMs: 30000, signal: abort.signal,
    run: () => runFourMonitor(s.deps), sleep: async ms => {
      assert.equal(ms, 30000);
      assert.equal(s.events[0], 'scan');
      assert.equal(s.events.at(-1), 'send');
      assert.equal(s.deliveries.length, 1);
      assert.equal(puts(s).length, 0);
      assert.ok(s.events.some(e => e.includes('/synthetic/cart')));
      abort.abort();
    } }));
  const j = await jobs(s);
  assert.deepEqual(Object.values(j).map(j => j.plan.targetQuantity), [3, 3, 1, 0]);
  assert.ok(Object.values(j).every(j => j.status === 'read-only' && j.after === 0));
  assert.match(s.deliveries[0], /Neues BRACK Pokémon-TCG-Produkt/);
  assert.match(s.deliveries[0], /nur gelesen, keine Änderung/);
  assert.ok(!s.deliveries[0].includes('Warenkorb geprüft'));
});

test('Freigegebener Schreibpfad nutzt aktuelle Limits, bestehende Positionen und prüft alle vier echten Warenkörbe', async t => {
  const s = await accountSetup(t, { write: true });
  s.server['brack-account-1'].items['100001'] = 2;
  s.server['brack-account-2'].items['100001'] = 1;
  s.server['brack-account-1'].items['999999'] = 2;
  const result = await s.run();
  assert.equal(result.cartVerified, 4);
  assert.deepEqual(s.accounts.map(a => s.server[a.id].items['100001'] ?? 0), [3, 3, 1, 0]);
  assert.equal(s.server['brack-account-1'].items['999999'], 2);
  assert.equal(puts(s).length, 3);
  for (const req of puts(s)) {
    assert.deepEqual(Object.keys(req.data), ['quantity']);
    assert.equal(req.headers['If-Match'], '"1"');
    assert.equal(req.headers['X-CSRF-Token'], 'SYNTHETIC-CSRF');
    const pos = s.requests.indexOf(req);
    assert.ok(s.requests.slice(pos + 1).some(r => r.id === req.id && r.path === '/synthetic/cart' && r.method === 'GET'));
  }
  assert.equal((await jobs(s))['brack-account-4'].attempts, 0);
  assert.equal(s.deliveries.length, 1);
  assert.match(s.deliveries[0], /brack-account-4: Warenkorb geprüft; Menge 0/);
});

test('Bestand null, unbekannte oder überschrittene Limits lösen keine PUTs aus', async t => {
  for (const changes of [{ stock: 0 }, { stock: null }, { accountLimit: null }, { globalLimit: undefined }, { complete: false }]) {
    const s = await accountSetup(t, { write: true });
    Object.assign(s.limits, changes);
    await s.run();
    assert.equal(puts(s).length, 0);
  }
  const s = await accountSetup(t, { write: true });
  s.server['brack-account-1'].items['100001'] = 8;
  await s.run();
  assert.equal(puts(s).length, 0);
  assert.ok(Object.values(await jobs(s)).every(j => j.status === 'blocked'));
});

test('Ausfall einer Sitzung wird getrennt gemeldet; andere drei Konten werden weiterhin gelesen', async t => {
  const s = await accountSetup(t);
  s.hooks.request = req => req.id === 'brack-account-1' ? { status: 401, json: {} } : undefined;
  s.server['brack-account-2'].items['100001'] = 1;
  await s.run();
  const j = await jobs(s);
  assert.equal(j['brack-account-1'].status, 'failed');
  assert.equal(j['brack-account-2'].status, 'read-only');
  assert.equal(j['brack-account-2'].after, 1);
  assert.equal(j['brack-account-2'].plan, undefined);
  assert.match(s.deliveries[0], /brack-account-1: Lesen fehlgeschlagen/);
  assert.match(s.deliveries[0], /brack-account-2: nur gelesen, keine Änderung; Menge 1/);
});

test('Englische Produkte werden vor deutschen Jubiläumsprodukten verarbeitet, andere ignoriert', async t => {
  const s = await accountSetup(t);
  const german = rawProduct(100002, { description: { nameWithoutManufacturer: '30 Jahre Jubiläum', shortTextList: ['Sprache: Deutsch'] } });
  const ignored = rawProduct(100003, { description: { nameWithoutManufacturer: 'Andere Serie', shortTextList: ['Sprache: Deutsch'] } });
  s.products([german, ignored, rawProduct()]);
  await s.run();
  const productReads = s.requests.filter(r => r.path.startsWith('/synthetic/products'));
  assert.equal(productReads[0].path, '/synthetic/products/100001');
  assert.ok(productReads.some(r => r.path.endsWith('/100002')));
  assert.ok(!productReads.some(r => r.path.endsWith('/100003')));
  assert.equal(s.deliveries.length, 2);
  assert.match(s.deliveries[0], /Sprache: Englisch/);
});

test('Wiederholter Scan/Neustart/Telegram-Retry führen zu keiner zweiten Warenkorbmutation', async t => {
  const s = await accountSetup(t, { write: true });
  let sends = 0;
  s.deps.telegram.send = async () => {
    sends++; throw new TelegramDeliveryError('network_before_send', 'retry', 120000);
  };
  await s.run();
  const count = puts(s).length;
  s.time.setTime(s.time.getTime() + 120001);
  s.deps.telegram.send = async text => { sends++; s.deliveries.push(text); return { mode: 'test', simulated: true }; };
  await s.run();
  await s.run();
  assert.equal(puts(s).length, count);
  assert.equal(sends, 2);
  assert.equal((await s.state()).discovery.entries['100001'].status, 'sent');
});

test('Neue Warenkörbe werden auch während einer Telegram-Pause sofort verarbeitet', async t => {
  const s = await accountSetup(t, { write: true });
  s.deps.telegram.send = async () => { throw new TelegramDeliveryError('rate_limited', 'retry', 120000); };
  await s.run();
  const before = puts(s).length;
  s.products([rawProduct(), rawProduct(100002)]);
  await s.run();
  assert.ok(puts(s).length > before);
  assert.ok(puts(s).some(r => r.path.endsWith('/100002')));
});

test('Unklarer PUT wird per GET abgeglichen und niemals wiederholt', async t => {
  const s = await accountSetup(t, { write: true });
  s.hooks.afterPut = () => { throw new Error('SYNTHETIC-COOKIE-IN-ERROR'); };
  await s.run();
  assert.equal((await jobs(s))['brack-account-1'].status, 'verified');
  assert.equal((await jobs(s))['brack-account-1'].code, 'reconciled_after_error');
  const count = puts(s).length;
  await s.run();
  assert.equal(puts(s).length, count);
  assert.ok(!JSON.stringify(await s.state()).includes('SYNTHETIC-COOKIE-IN-ERROR'));
});

test('Abweichende Positionen nach PUT werden angehalten und sperren weitere Mengenplanung', async t => {
  const s = await accountSetup(t, { write: true });
  s.hooks.afterPut = () => { s.server['brack-account-1'].items['999999'] = 1; };
  await s.run();
  assert.equal(puts(s).length, 1);
  assert.equal((await jobs(s))['brack-account-1'].status, 'uncertain');
  assert.match(s.deliveries[0], /Ausgang unklar, keine Wiederholung/);
  await s.run();
  assert.equal(puts(s).length, 1);
});

test('Absturz nach erfolgreichem PUT vor Speicherung: Neustart gleicht nur lesend ab', async t => {
  const s = await accountSetup(t, { write: true });
  const save = s.deps.store.save.bind(s.deps.store);
  let failOnce = true;
  s.deps.store.save = async state => {
    if (failOnce && state.realCarts?.products['100001']?.jobs['brack-account-1']?.status === 'verified') {
      failOnce = false; throw new Error('Synthetic disk failure');
    }
    return save(state);
  };
  await assert.rejects(s.run(), /disk failure/);
  assert.equal((await jobs(s))['brack-account-1'].status, 'mutating');
  assert.equal(puts(s).length, 1);
  await s.run();
  assert.equal(puts(s).filter(r => r.id === 'brack-account-1').length, 1);
  assert.equal((await jobs(s))['brack-account-1'].code, 'reconciled_after_restart');
  assert.equal((await jobs(s))['brack-account-1'].status, 'verified');
});

test('Speicherfehler vor PUT, abgelaufene Freigabe oder veralteter Scan verhindern Schreibzugriff', async t => {
  const s = await accountSetup(t, { write: true });
  const save = s.deps.store.save.bind(s.deps.store);
  let failOnce = true;
  s.deps.store.save = async state => {
    if (failOnce && state.realCarts?.products['100001']?.jobs['brack-account-1']?.status === 'mutating') {
      failOnce = false; throw new Error('Synthetic disk failure');
    }
    return save(state);
  };
  await s.run();
  assert.equal(puts(s).length, 0);
  const expired = await accountSetup(t, { write: true });
  expired.time.setTime(expired.time.getTime() + 3600001);
  await assert.rejects(expired.run(), /cart_writes_not_approved/);
  assert.equal(puts(expired).length, 0);
  const stale = await accountSetup(t, { write: true });
  const scan = stale.deps.scanner.scan.bind(stale.deps.scanner);
  stale.deps.scanner.scan = async () => { const p = await scan(); stale.time.setTime(stale.time.getTime() + 60001); return p; };
  await stale.run();
  assert.equal(puts(stale).length, 0);
});

test('Kontozugriffsschutz stoppt weitere Konten; 429 bewahrt die längere Pause', async t => {
  for (const status of [403, 429]) {
    const s = await accountSetup(t);
    s.hooks.request = () => ({ status, headers: { 'retry-after': '120' }, json: {} });
    const result = await s.run();
    assert.equal(s.requests.length, 1);
    if (status === 403) assert.equal(result.halted, true);
    else assert.equal(result.retryAfterMs, 120000);
    await s.run();
    assert.equal(s.requests.length, 1);
  }
});

test('Neue Artikel während BRACK-429 bleiben bis nach der Schutzpause für Warenkorbprüfung vorgemerkt', async t => {
  const s = await accountSetup(t);
  s.hooks.request = () => ({ status: 429, headers: { 'retry-after': '120' }, json: {} });
  await s.run();
  s.products([rawProduct(), rawProduct(100002)]);
  s.hooks.request = undefined;
  await s.run();
  assert.equal(s.deliveries.length, 1);
  assert.equal((await s.state()).discovery.entries['100002'].status, 'pending');
  s.time.setTime(s.time.getTime() + 120001);
  await s.run();
  assert.equal(s.deliveries.length, 2);
  assert.match(s.deliveries[1], /100002/);
  assert.match(s.deliveries[1], /nur gelesen/);
});

test('Baseline befüllt nichts und getauschte Konto-/Betriebszustände werden abgewiesen', async t => {
  const s = await accountSetup(t, { write: true });
  s.deps.baseline = true;
  await s.run();
  assert.equal(s.requests.length, 0);
  assert.equal(s.deliveries.length, 0);
  s.deps.baseline = false;
  s.products([rawProduct(), rawProduct(100002)]);
  await s.run();
  assert.ok(puts(s).every(r => r.path.endsWith('/100002')));
  const state = await s.state();
  state.realCarts.mode = 'read-test';
  await s.deps.store.save(state);
  await assert.rejects(s.run(), /real_cart_state_invalid/);
});

test('Fehlendes/null Warenkorbledger wird bei bestehender Entdeckung nicht neu initialisiert', async t => {
  for (const kind of ['null', 'missing']) {
    const s = await accountSetup(t, { write: true });
    await s.run();
    const count = puts(s).length, state = await s.state();
    if (kind === 'null') state.realCarts = null;
    else delete state.realCarts;
    await s.deps.store.save(state);
    await assert.rejects(s.run(), /real_cart_state_invalid/);
    assert.equal(puts(s).length, count);
  }
});
