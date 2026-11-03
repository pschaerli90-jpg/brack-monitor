import { validateProduct, priority } from '../filter.js';
import { productUrl } from '../brack/parser.js';

export function discoveryProduct(product) {
  validateProduct(product);
  if (!/^[1-9]\d*$/.test(product.id) || !priority(product) ||
      (product.stock !== null && (!Number.isSafeInteger(product.stock) || product.stock < 0))) throw new Error('Ungültiger Telegram-Produktdatensatz');
  return { id: product.id, name: product.name, brand: product.brand, category: product.category,
    language: product.language, series: product.series, stock: product.stock, url: productUrl(product.url, product.id) };
}

export function discoveryMessage(product, { discoveredAt } = {}) {
  const p = discoveryProduct(product);
  const text = 'Neues BRACK Pokémon-TCG-Produkt\nProdukt: ' + p.name +
    '\nArtikelnummer: ' + p.id + '\nSprache: ' + ({ en: 'Englisch', de: 'Deutsch' })[p.language] +
    '\nLagerbestand (bei Erkennung): ' + (p.stock === null ? 'unbekannt' : p.stock) +
    '\nLink: ' + p.url + (discoveredAt ? '\nErkannt am: ' + discoveredAt : '');
  if (text.length > 4096) throw new Error('Produktmeldung überschreitet das Telegram-Limit');
  return text;
}

export class SimulatedTelegramDelivery {
  mode = 'test';
  async send(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new Error('Ungültige Testmeldung');
    return { mode: 'test', simulated: true };
  }
}
