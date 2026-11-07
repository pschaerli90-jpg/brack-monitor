import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationSelected, priority } from '../src/filter.js';
import { parseListing, productImageUrl } from '../src/brack/parser.js';
import { readFile } from 'node:fs/promises';
import { rawProduct, listing } from './helpers/brack.js';

test('Pokémon EN, DE und FR werden unabhängig von Serie/Kategorie gleich ausgewählt', () => {
  const input = ['fr', 'de', 'en'].map((language, i) => ({
    id: String(i + 1), brand: 'pokemon', language, category: 'other', series: 'unknown'
  }));
  assert.ok(input.every(notificationSelected));
  assert.deepEqual(input.filter(notificationSelected).map(p => p.language), ['fr', 'de', 'en']);
  for (const p of [{ ...input[0], brand: 'other' }, { ...input[0], language: 'ja' },
    { ...input[0], language: 'unknown' }, { ...input[0], language: 'it' }, null]) {
    assert.equal(notificationSelected(p), false);
  }
  // Existing simulated scanners retain their own policy.
  assert.equal(priority({ brand: 'pokemon', category: 'tcg', language: 'en', series: 'unknown' }), 2);
  assert.equal(priority({ brand: 'pokemon', category: 'tcg', language: 'fr', series: 'unknown' }), 0);
});

test('Explizite französische, deutsche und englische Produktsprache; keine Ableitung aus Website-Locale', () => {
  for (const [attribute, expected] of [
    ['Französisch', 'fr'], ['Français', 'fr'], ['FR', 'fr'],
    ['Deutsch', 'de'], ['DE', 'de'], ['Englisch', 'en'], ['EN', 'en'],
    ['Japanisch', 'unknown'], ['Deutsch, Französisch', 'unknown']
  ]) {
    const p = parseListing(listing([rawProduct(100001, {
      language: 'fr', description: { nameWithoutManufacturer: 'Pokemon product', shortTextList: ['Sprache: ' + attribute] }
    })])).products[0];
    assert.equal(p.language, expected);
  }
  const ambiguous = rawProduct(100001, {
    description: { nameWithoutManufacturer: 'Pokemon product', shortTextList: ['Sprache: Deutsch', 'Sprache: Französisch'] }
  });
  assert.equal(parseListing(listing([ambiguous])).products[0].language, 'unknown');
});

test('Echtes bereinigtes MAIN-Bildschema liefert ausschliesslich die beobachtete BRACK-Asset-URL', async () => {
  const raw = JSON.parse(await readFile(new URL('../fixtures/brack-product-image.json', import.meta.url), 'utf8'));
  const product = parseListing(listing([raw])).products[0];
  assert.equal(product.id, '2054891');
  assert.equal(product.brand, 'pokemon');
  assert.equal(product.language, 'fr');
  assert.equal(product.imageUrl, 'https://assets.brack.ch/images2/8/0/9/412765908/412765908_xl.jpg');
  assert.equal(productImageUrl('/images2/6/0/5/373526506/373526506_xxl.jpg'),
    'https://assets.brack.ch/images2/6/0/5/373526506/373526506_xxl.jpg');
});

test('Fehlende, mehrdeutige oder fremde Produktbilder erzeugen keinen erfundenen Ersatz', () => {
  const base = rawProduct();
  for (const images of [undefined, [], {}, [{ type: 'OTHER', sizes: [] }],
    [{ type: 'MAIN', sizes: [{ variant: 'XL', src: 'https://evil.example/a.jpg' }] }],
    [{ type: 'MAIN', sizes: [] }, { type: 'MAIN', sizes: [] }]]) {
    assert.equal(parseListing(listing([{ ...base, images }])).products[0].imageUrl, null);
  }
  assert.equal(productImageUrl(null), null);
  assert.equal(productImageUrl(undefined), null);
});

test('Produktbildprüfung blockiert fremde Hosts, Schemas, Zugangsdaten, Traversal und Zusatzparameter', () => {
  const path = '/images2/6/0/5/373526506/373526506_xl.jpg';
  for (const value of [
    'https://evil.example' + path, '//evil.example' + path,
    'http://assets.brack.ch' + path, 'javascript:alert(1)', 'data:image/png;base64,AAA',
    'https://assets.brack.ch.evil.example' + path,
    'https://user:pass@assets.brack.ch' + path,
    'https://assets.brack.ch:443' + path, 'https://assets.brack.ch:444' + path,
    '/images2/../images2/6/0/5/373526506/373526506_xl.jpg',
    '/images2/%2e%2e/images2/6/0/5/373526506/373526506_xl.jpg',
    path + '?url=https://evil.example/a.jpg', path + '#fragment', ''
  ]) assert.throws(() => productImageUrl(value), undefined, value);
});
