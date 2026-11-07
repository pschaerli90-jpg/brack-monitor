import { validateProduct, notificationSelected } from '../filter.js';
import { productUrl, productImageUrl } from '../brack/parser.js';

export function discoveryProduct(product) {
  validateProduct(product);
  if (!/^[1-9]\d*$/.test(product.id) || !notificationSelected(product) ||
      (product.stock !== null && (!Number.isSafeInteger(product.stock) || product.stock < 0))) throw new Error('Ungültiger Telegram-Produktdatensatz');
  return { id: product.id, name: product.name, brand: product.brand, category: product.category,
    language: product.language, series: product.series, stock: product.stock, url: productUrl(product.url, product.id),
    imageUrl: productImageUrl(product.imageUrl) };
}

// firstSeenAt remains in the outbox/logs; it is intentionally not rendered.
export function discoveryMessage(product) {
  const p = discoveryProduct(product);
  const prefix = 'Neues BRACK Pokémon-Produkt\nProdukt: ';
  const details = '\nArtikelnummer: ' + p.id + '\nSprache: ' + ({ en: 'Englisch (EN)', de: 'Deutsch (DE)', fr: 'Französisch (FR)' })[p.language] +
    '\nLagerbestand (bei Erkennung): ' + (p.stock === null ? 'unbekannt' : p.stock) + '\nLink: ' + p.url;
  const budget = 1024 - prefix.length - details.length;
  if (budget < 2) throw new Error('Produktlink überschreitet das Telegram-Bildtextlimit');
  const name = p.name.length > budget ? p.name.slice(0, budget - 1) + '…' : p.name;
  const text = prefix + name + details;
  return text;
}

export class SimulatedTelegramDelivery {
  mode = 'test';
  async send(text, { imageUrl } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > (imageUrl ? 1024 : 4096)) throw new Error('Ungültige Testmeldung');
    if (imageUrl) productImageUrl(imageUrl);
    return { mode: 'test', simulated: true };
  }
}
