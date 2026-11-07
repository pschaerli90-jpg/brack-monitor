import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseListing, BRACK_URL } from '../src/brack/parser.js';
import { BrackScanner } from '../src/brack/scanner.js';
import { TestLimitsPolicy } from '../src/brack/limits-policy.js';
import { priority, notificationSelected } from '../src/filter.js';
import { listing, rawProduct, NOW, EXPIRY } from './helpers/brack.js';

test('Echtes bereinigtes BRACK-Schema: 32 stabile Artikel in Server-Reihenfolge', async () => {
  const html = await readFile(new URL('../fixtures/brack-listing.html', import.meta.url), 'utf8');
  const page = parseListing(html, { observedAt: NOW });
  assert.equal(page.products.length, 32);
  assert.equal(page.products[0].id, '2179871');
  assert.equal(page.products[1].language, 'unknown'); // Japanese card, German website
  assert.equal(page.products.filter(p => priority(p)).length, 0);
  assert.deepEqual(page.products.filter(notificationSelected).map(p => p.language), ['fr', 'de', 'fr', 'fr', 'fr', 'fr']);
  assert.equal(page.products.find(p => p.id === '2151394').stock, 0);
  assert.equal(page.next, null);
});

test('Produktsprache, TCG, Marke und Jubiläumsserie bestimmen Priorität', () => {
  const en = rawProduct();
  const de = rawProduct(100002, { description: { nameWithoutManufacturer: '30 Jahre Jubiläum Box', shortTextList: ['Sprache: Deutsch'] } });
  const products = [en, de, { ...de, sku: 100003, url: '/other-100003', breadcrumbs: [] },
    rawProduct(100004, { manufacturer: { name: 'Other' }, description: { nameWithoutManufacturer: 'English', shortTextList: ['Sprache: Englisch'] } }),
    rawProduct(100005, { description: { nameWithoutManufacturer: '30 Jahre Jubiläum English', shortTextList: ['Sprache: Deutsch, Englisch'] } })];
  assert.deepEqual(parseListing(listing(products)).products.map(priority), [2, 1, 0, 0, 0]);
  const p = parseListing(listing([en]), { observedAt: NOW }).products[0];
  assert.equal(p.language, 'en');
  assert.equal(p.maxPerOrder, null);
  assert.equal(p.globalLimit, null);
  assert.equal(p.source.observedAt, NOW);
  assert.equal(p.url, 'https://www.brack.ch/pokemon-english-booster-100001');
});

test('Unbekannte Verfügbarkeit und vorbestellte Ware ergeben keinen erfundenen Bestand', () => {
  for (const [inventory, expected] of [[{ current: -5, stockInOrder: [{ quantity: 100 }] }, 0], [{}, null], [{ current: '12' }, null]]) {
    assert.equal(parseListing(listing([rawProduct(100001, { inventory })])).products[0].stock, expected);
  }
  assert.equal(parseListing(listing([rawProduct(100001, { states: { active: false } })])).products[0].stock, null);
});

test('Unbekanntes Schema, falsche Sortierung, fremde Links und CAPTCHA stoppen den Scan', () => {
  for (const html of [listing().replace('"sku":100001', '"sku":100002'), listing([], { sort: 'rankasc' }),
    '<html>login</html>', listing().replace('"order":[100001]', '"order":[100001,100001]'),
    listing([rawProduct(100001, { url: 'https://evil.example/p-100001' })])]) {
    assert.throws(() => parseListing(html));
  }
  assert.throws(() => parseListing('<title>Just a moment...</title>'), { name: 'AccessRestrictedError' });
  assert.throws(() => parseListing('<div class="g-recaptcha"></div>'), { name: 'AccessRestrictedError' });
  assert.throws(() => parseListing(listing([], { next: 'https://evil.example' })), /Folgelink/);
  assert.throws(() => parseListing(listing([], { next: BRACK_URL.replace('newdesc', 'rankasc') })), /Folgelink/);
});

test('Scanner liest verlinkte Seiten seriell und veröffentlicht nur vollständige Scans', async () => {
  const next = BRACK_URL + '&page=2';
  const calls = [];
  const scanner = new BrackScanner({ now: () => new Date(NOW), http: { get: async url => {
    calls.push(url);
    return url === BRACK_URL ? listing([rawProduct()], { total: 2, next }) : listing([rawProduct(100002)], { total: 2, page: 2 });
  } } });
  assert.deepEqual((await scanner.scan()).map(p => p.id), ['100001', '100002']);
  assert.deepEqual(calls, [BRACK_URL, next]);
  scanner.http.get = async () => listing([rawProduct()], { total: 2 });
  await assert.rejects(scanner.scan(), /unvollständig/);
  scanner.http.get = async url => listing([rawProduct()], { total: 2, next: url === BRACK_URL ? next : BRACK_URL, page: url === BRACK_URL ? 1 : 2 });
  await assert.rejects(scanner.scan(), /verschoben/);
  scanner.maxPages = 1;
  await assert.rejects(scanner.scan(), /Paginierung/);
});

test('Geänderte Trefferzahlen und Seitenfolge werden abgelehnt', async () => {
  const scanner = new BrackScanner({ http: { get: async url => url === BRACK_URL ?
    listing([rawProduct()], { total: 2, next: BRACK_URL + '&page=2' }) : listing([rawProduct(100002)], { total: 3, page: 2 }) } });
  await assert.rejects(scanner.scan(), /änderte sich/);
  scanner.http.get = async () => listing([rawProduct()], { page: 2 });
  await assert.rejects(scanner.scan(), /änderte sich/);
});

test('Nur explizite gültige Testlimits werden übernommen; Ablauf und Nullgrenzen bleiben sicher', () => {
  const config = { version: 1, products: { '100001': { maxPerOrder: 2, globalLimit: 5, accountLimits: { 'mock-account-1': 0 }, expiresAt: EXPIRY } } };
  const policy = new TestLimitsPolicy(config);
  config.products['100001'].globalLimit = 100;
  const p = parseListing(listing()).products[0];
  assert.equal(policy.apply(p, new Date(NOW)).globalLimit, 5);
  assert.equal(policy.apply(p, new Date(EXPIRY)).globalLimit, null);
  assert.equal(policy.apply({ ...p, id: '999999' }, new Date(NOW)).globalLimit, null);
  for (const changes of [{ globalLimit: -1 }, { maxPerOrder: 1.5 }, { expiresAt: 'invalid' }, { accountLimits: { 'other-account': 1 } }]) {
    assert.throws(() => new TestLimitsPolicy({ version: 1, products: { '100001': { ...config.products['100001'], ...changes } } }));
  }
});
