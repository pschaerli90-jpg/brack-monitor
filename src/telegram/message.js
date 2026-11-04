import { validateProduct, priority } from '../filter.js';
import { productUrl } from '../brack/parser.js';

export function discoveryProduct(product) {
  validateProduct(product);
  if (!/^[1-9]\d*$/.test(product.id) || !priority(product) ||
      (product.stock !== null && (!Number.isSafeInteger(product.stock) || product.stock < 0))) throw new Error('Ungültiger Telegram-Produktdatensatz');
  return { id: product.id, name: product.name, brand: product.brand, category: product.category,
    language: product.language, series: product.series, stock: product.stock, url: productUrl(product.url, product.id) };
}

export function discoveryMessage(product, { discoveredAt, cartResults } = {}) {
  const p = discoveryProduct(product);
  let text = 'Neues BRACK Pokémon-TCG-Produkt\nProdukt: ' + p.name +
    '\nArtikelnummer: ' + p.id + '\nSprache: ' + ({ en: 'Englisch', de: 'Deutsch' })[p.language] +
    '\nLagerbestand (bei Erkennung): ' + (p.stock === null ? 'unbekannt' : p.stock) +
    '\nLink: ' + p.url + (discoveredAt ? '\nErkannt am: ' + discoveredAt : '');
  if (cartResults !== undefined) {
    if (!Array.isArray(cartResults) || cartResults.length !== 4 || cartResults.some((r, i) =>
      r?.accountId !== 'brack-account-' + (i + 1) ||
      !['read-only', 'verified', 'blocked', 'failed', 'uncertain'].includes(r.status) ||
      (r.quantity !== undefined && (!Number.isSafeInteger(r.quantity) || r.quantity < 0)) ||
      (r.targetQuantity !== undefined && (!Number.isSafeInteger(r.targetQuantity) || r.targetQuantity < 0)) ||
      (['verified', 'read-only'].includes(r.status) && (r.quantity === undefined || !Number.isFinite(Date.parse(r.checkedAt)))))) {
      throw new Error('Ungültige verifizierte Warenkorbergebnisse');
    }
    text += '\n\nBRACK-Konten (kein Checkout):';
    for (const r of cartResults) {
      const label = { 'read-only': 'nur gelesen, keine Änderung', verified: 'Warenkorb geprüft',
        blocked: 'gesperrt, nicht befüllt', failed: 'Lesen fehlgeschlagen', uncertain: 'Ausgang unklar, keine Wiederholung' }[r.status];
      text += '\n' + r.accountId + ': ' + label +
        (r.quantity !== undefined ? '; Menge ' + r.quantity : '') +
        (r.status === 'read-only' && r.targetQuantity !== undefined ? '; möglicher Zielwert ' + r.targetQuantity : '') +
        (r.checkedAt ? '; geprüft ' + r.checkedAt : '');
    }
  }
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
