import { readFile } from 'node:fs/promises';

const integer = n => Number.isSafeInteger(n) && n >= 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Explicit local TEST ceilings. These never establish permission for a real cart.
export class TestLimitsPolicy {
  constructor(config) {
    if (config?.version !== 1 || !record(config.products)) throw new Error('Ungültige Testlimit-Konfiguration');
    for (const [id, p] of Object.entries(config.products)) {
      if (!/^[1-9]\d*$/.test(id) || !record(p) || !integer(p.maxPerOrder) || !integer(p.globalLimit) ||
          !Number.isFinite(Date.parse(p.expiresAt)) ||
          (p.accountLimits !== undefined && (!record(p.accountLimits) || Object.entries(p.accountLimits)
            .some(([a, n]) => !/^mock-account-[1-4]$/.test(a) || !integer(n))))) throw new Error('Ungültiges Testlimit für Artikel ' + id);
    }
    this.products = structuredClone(config.products);
  }
  static async fromFile(path) { return new TestLimitsPolicy(JSON.parse(await readFile(path, 'utf8'))); }
  apply(product, now = new Date()) {
    const policy = this.products[product.id];
    if (!policy || Date.parse(policy.expiresAt) <= now.getTime()) return product;
    return { ...product, maxPerOrder: policy.maxPerOrder, globalLimit: policy.globalLimit,
      accountLimits: policy.accountLimits, limitSource: 'local-test-policy', limitsExpireAt: policy.expiresAt };
  }
}
