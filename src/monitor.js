import { priority, validateProduct } from './filter.js';

export const jsonLogger = event => console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));

export async function runMonitor({ scanner, cart, telegram, store, log = jsonLogger }) {
  return store.locked(async () => {
    const state = await store.load();
    const summary = { discovered: 0, ignored: 0, completed: 0, failed: 0 };
    let products;
    try {
      products = await scanner.scan();
      if (!Array.isArray(products)) throw new Error('Scanner muss eine Produktliste liefern');
    } catch (err) {
      summary.failed++;
      log({ event: 'scan_failed', error: err.message });
      // Persisted pending work is still processed if the scanner fails.
      products = [];
    }
    for (const product of products) {
      try {
        validateProduct(product);
        if (!priority(product)) { summary.ignored++; continue; }
        const key = `product:${product.id}`;
        if (!Object.hasOwn(state.products, key)) {
          state.products[key] = { key, product, status: 'pending', attempts: 0, firstSeen: new Date().toISOString() };
          summary.discovered++;
        } else if (state.products[key].status === 'pending') {
          state.products[key].product = product;
        }
      } catch (err) { summary.failed++; log({ event: 'invalid_product', error: err.message }); }
    }
    await store.save(state);
    const pending = Object.values(state.products).filter(p => p.status !== 'done')
      .sort((a, b) => priority(b.product) - priority(a.product));
    for (const entry of pending) {
      entry.attempts++;
      try {
        if (entry.status === 'pending') {
          entry.cart = await cart.prepare(entry.product, { idempotencyKey: entry.key });
          entry.status = 'prepared';
          await store.save(state);
        }
        const message = `SIMULATION | ${entry.product.name} | Sprache: ${entry.product.language} | Reihe: ${entry.product.series} | Zielmenge: ${entry.cart.targetQuantity} | Hinzufügen: ${entry.cart.addQuantity} | Kein echter Warenkorb, keine Bestellung.`;
        entry.notification = await telegram.send(message, { idempotencyKey: `${entry.key}:telegram` });
        entry.status = 'done';
        entry.completedAt = new Date().toISOString();
        delete entry.lastError;
        summary.completed++;
      } catch (err) {
        entry.lastError = err.message;
        summary.failed++;
        log({ event: 'product_failed', id: entry.product.id, stage: entry.status, error: err.message });
      }
      await store.save(state);
    }
    log({ event: 'run_completed', mode: 'mock', ...summary });
    return summary;
  });
}
