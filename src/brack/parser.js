import { AccessRestrictedError } from './http.js';

export const BRACK_URL = 'https://www.brack.ch/sport-freizeit/spielwaren/puzzles-spiele/spiele/sammelkarten?sortProducts=newdesc&query=pok%C3%A9mon';
const norm = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase() : '';
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const article = value => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9]\d*$/.test(String(value));
const attributes = text => Object.fromEntries([...text.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
  .map(m => [m[1].toLowerCase(), m[2] ?? m[3]]));

export function productUrl(value, id) {
  if (typeof value !== 'string') throw new Error('Produktlink fehlt');
  const url = new URL(value, BRACK_URL);
  if (url.origin !== 'https://www.brack.ch' || url.username || url.password ||
      !url.pathname.endsWith('-' + id) || !/^\/[a-z0-9-]+$/.test(url.pathname)) throw new Error('Ungültiger BRACK-Produktlink');
  url.search = ''; url.hash = '';
  return url.href;
}

// Observed BRACK listing images are published at this exact asset origin.
// Relative MAIN-image paths come directly from images[].sizes[].src.
export function productImageUrl(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > 2048 || /[\s%\\]/.test(value) ||
      /(?:^|\/)\.\.?(?:\/|$)/.test(value) || /\/\/[^/?#]*:/.test(value)) {
    throw new Error('Ungültiger BRACK-Produktbildlink');
  }
  const url = new URL(value, 'https://assets.brack.ch');
  if (url.origin !== 'https://assets.brack.ch' || url.username || url.password || url.port ||
      url.search || url.hash || !/^\/images2\/(?:[a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp)$/.test(url.pathname)) {
    throw new Error('Ungültiger BRACK-Produktbildlink');
  }
  return url.href;
}

function mainImage(raw) {
  if (!Array.isArray(raw.images)) return null;
  const main = raw.images.filter(image => image?.type === 'MAIN');
  if (main.length !== 1 || !Array.isArray(main[0].sizes)) return null;
  // All candidates are supplied by BRACK. Missing/unusable images stay absent.
  for (const variant of ['XL', 'XXL', 'L', 'M', 'S']) {
    for (const size of main[0].sizes.filter(size => size?.variant === variant)) {
      try {
        const image = productImageUrl(size.src);
        if (image) return image;
      } catch { /* An invalid image URL never makes an invented fallback valid. */ }
    }
  }
  return null;
}

function normaliseProduct(raw, id, observedAt) {
  if (!record(raw) || !article(raw.sku) || String(raw.sku) !== id ||
      typeof raw.description?.nameWithoutManufacturer !== 'string' || !raw.description.nameWithoutManufacturer.trim() ||
      !Array.isArray(raw.description.shortTextList) || !Array.isArray(raw.breadcrumbs)) throw new Error('Unbekanntes BRACK-Produktschema: ' + id);
  const fields = key => raw.description.shortTextList.filter(v => typeof v === 'string' && v.startsWith(key + ':'))
    .map(v => norm(v.slice(key.length + 1)));
  const languages = fields('Sprache');
  // raw.language is the website locale, NOT the trading card's language.
  const language = languages.length === 1 ? ({
    englisch: 'en', english: 'en', en: 'en',
    deutsch: 'de', german: 'de', de: 'de',
    französisch: 'fr', français: 'fr', french: 'fr', fr: 'fr'
  }[languages[0]] ?? 'unknown') : 'unknown';
  const pokemon = norm(raw.manufacturer?.name) === 'the pokémon company' || fields('Themenwelt').includes('pokémon');
  const tcg = raw.breadcrumbs.some(b => norm(b?.name) === 'sammelkarten');
  const title = raw.description.nameWithoutManufacturer.trim();
  const series = fields('Serie');
  const anniversary = series.includes('30 jahre jubiläum') || /\b30[\s-]+jahre[\s-]+jubiläum\b/iu.test(title);
  const stock = Number.isSafeInteger(raw.inventory?.current) ? Math.max(0, raw.inventory.current) : null;
  return {
    id, name: title, url: productUrl(raw.url, id), imageUrl: mainImage(raw),
    brand: pokemon ? 'pokemon' : 'other', category: tcg ? 'tcg' : 'other', language,
    series: anniversary ? '30-jahre-jubilaeum' : 'unknown',
    stock: raw.states?.active === true ? stock : null,
    maxPerOrder: null, globalLimit: null,
    source: { provider: 'brack', observedAt, stockMeaning: 'inventory.current; negative values treated as unavailable' }
  };
}

// Parse only public listing state, never INITIAL_STATE (which can contain session data).
export function parseListing(html, { url = BRACK_URL, observedAt = new Date().toISOString() } = {}) {
  if (/<title[^>]*>[^<]*(?:captcha|access denied|just a moment|zugriff verweigert)/iu.test(html) || /(?:cf-chl-|g-recaptcha|h-captcha)/iu.test(html)) {
    throw new AccessRestrictedError('BRACK-Zugriffsschutz erkannt; Scan gestoppt');
  }
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .map(m => ({ attrs: attributes(m[1]), body: m[2] }));
  function json(id) {
    const found = scripts.filter(s => s.attrs.id === id && s.attrs.type === 'application/json');
    if (found.length !== 1) throw new Error('BRACK-Listenschema fehlt oder ist mehrdeutig: ' + id);
    return JSON.parse(found[0].body);
  }
  const data = json('b2c-search-products');
  const metadata = json('b2c-search-datalayer').oss;
  if (!record(data.productDataMap) || !Array.isArray(data.order) || !record(metadata) || metadata.sortType !== 'newdesc' ||
      !/^\d+$/.test(String(metadata.resultsCount)) || !Number.isSafeInteger(Number(metadata.resultsCount)) ||
      !/^[1-9]\d*$/.test(String(metadata.pageIndex))) throw new Error('Unbekanntes BRACK-Listen- oder Sortierschema');
  const order = data.order.map(id => { if (!article(id)) throw new Error('Ungültige Artikelnummer'); return String(id); });
  if (new Set(order).size !== order.length || Object.keys(data.productDataMap).length !== order.length) throw new Error('Inkonsistente BRACK-Artikelliste');
  const products = order.map(id => normaliseProduct(data.productDataMap[id], id, observedAt));
  const nextLinks = [...html.matchAll(/<(?:a|link)\b([^>]*)>/gi)].map(m => attributes(m[1]))
    .filter(a => a.rel?.split(/\s+/).includes('next'));
  if (nextLinks.length > 1) throw new Error('Mehrdeutige BRACK-Paginierung');
  let next = null;
  if (nextLinks.length) {
    if (!nextLinks[0].href) throw new Error('BRACK-Folgelink ohne Ziel');
    const candidate = new URL(nextLinks[0].href?.replaceAll('&amp;', '&'), url);
    const current = new URL(url);
    if (candidate.origin !== current.origin || candidate.pathname !== current.pathname || candidate.username || candidate.password ||
        candidate.searchParams.get('sortProducts') !== 'newdesc' || candidate.searchParams.get('query') !== 'pokémon') {
      throw new Error('Unsicherer oder falsch sortierter BRACK-Folgelink');
    }
    next = candidate.href;
  }
  return { products, next, total: Number(metadata.resultsCount), page: Number(metadata.pageIndex) };
}
