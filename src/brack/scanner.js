import { BrackHttp } from './http.js';
import { BRACK_URL, parseListing } from './parser.js';

export class BrackScanner {
  mode = 'read-only';
  constructor({ http = new BrackHttp(), now = () => new Date(), maxPages = 10, policy = null } = {}) {
    if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new Error('Ungültiges Seitenlimit');
    Object.assign(this, { http, now, maxPages, policy });
  }
  async scan() {
    let url = BRACK_URL;
    let total = null;
    const products = new Map();
    const visited = new Set();
    const observedAt = this.now().toISOString();
    while (url) {
      if (visited.has(url) || visited.size >= this.maxPages) throw new Error('BRACK-Paginierung unvollständig oder zyklisch');
      visited.add(url);
      const page = parseListing(await this.http.get(url), { url, observedAt });
      if (page.page !== visited.size || (total !== null && page.total !== total)) throw new Error('BRACK-Liste änderte sich während des Scans; später erneut versuchen');
      total = page.total;
      for (const p of page.products) {
        if (products.has(p.id)) throw new Error('Artikel über mehrere BRACK-Seiten verschoben; später erneut versuchen');
        products.set(p.id, this.policy ? this.policy.apply(p, this.now()) : p);
      }
      url = page.next;
    }
    // A partial response must never make old inventory appear current.
    if (products.size !== total) throw new Error('BRACK-Liste unvollständig; keine bestätigte vollständige Paginierung');
    return [...products.values()];
  }
}
