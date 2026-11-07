export const NOW = '2026-11-02T12:00:00.000Z';
export const EXPIRY = '2026-11-03T12:00:00.000Z';
export const rawProduct = (id = 100001, changes = {}) => ({
  sku: id, language: 'de', url: '/pokemon-english-booster-' + id,
  breadcrumbs: [{ name: 'Sammelkarten' }], manufacturer: { name: 'The Pokémon Company' },
  description: { nameWithoutManufacturer: 'Pokémon English Booster', shortTextList: ['Sprache: Englisch', 'Themenwelt: Pokémon'] },
  images: [{ type: 'MAIN', sizes: [{ variant: 'XL', src: '/images2/6/0/5/373526506/373526506_xl.jpg' }] }],
  inventory: { current: 12 }, states: { active: true }, ...changes
});
export function listing(products = [rawProduct()], { total = products.length, page = 1, sort = 'newdesc', next = null } = {}) {
  return '<!doctype html><title>BRACK</title><script type="application/json" id="b2c-search-products">' +
    JSON.stringify({ productDataMap: Object.fromEntries(products.map(p => [p.sku, p])), order: products.map(p => p.sku) }) +
    '</script><script id="b2c-search-datalayer" type="application/json">' +
    JSON.stringify({ oss: { resultsCount: String(total), pageIndex: String(page), sortType: sort } }) +
    '</script>' + (next ? '<a rel="next" href="' + next.replaceAll('&', '&amp;') + '">Weiter</a>' : '');
}
