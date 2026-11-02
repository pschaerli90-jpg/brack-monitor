import { readFile } from 'node:fs/promises';
import { quantityPlan } from './filter.js';

export class MockScanner {
  async scan() {
    return JSON.parse(await readFile(new URL('../fixtures/products.json', import.meta.url), 'utf8'));
  }
}

// No HTTP client, credentials, real URLs or external side effects.
export class MockCart {
  async prepare(product, { idempotencyKey }) {
    const plan = quantityPlan(product);
    if (plan.targetQuantity === 0) throw new Error('Produkt aktuell nicht verfügbar');
    return { mode: 'mock', reference: idempotencyKey, productId: product.id, ...plan };
  }
}

export class MockTelegram {
  async send(message, { idempotencyKey }) {
    return { mode: 'mock', reference: idempotencyKey, message };
  }
}
