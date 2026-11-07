import { priority, validateProduct } from './filter.js';
import { validateAccounts } from './accounts.js';
import { jsonLogger } from './monitor.js';
import { preparationMessage } from './notification.js';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const keyFor = (productId, accountId) => JSON.stringify([productId, accountId]);

function initialise(state, accounts) {
  if (!state.multi) {
    if (Object.keys(state.products).length) throw new Error('Separaten Zustand für Vier-Konten-Betrieb verwenden');
    state.multi = { version: 1, accounts: Object.fromEntries(accounts.map(a => [a.id,
      { session: null, cart: {}, history: [], lastError: null }])), products: {}, queue: {} };
  }
  const m = state.multi;
  if (!object(m) || m.version !== 1 || !object(m.accounts) || !object(m.products) || !object(m.queue) ||
      Object.keys(m.accounts).length !== 4 || accounts.some(a => !Object.hasOwn(m.accounts, a.id))) throw new Error('Ungültiger Vier-Konten-Zustand');
  for (const [id, a] of Object.entries(m.accounts)) {
    if (!object(a) || !object(a.cart) || !Array.isArray(a.history) || Object.values(a.cart).some(q => !integer(q)) ||
        (a.session !== null && (a.session?.mode !== 'mock' || a.session.accountId !== id))) throw new Error('Ungültiger Kontozustand');
  }
  for (const [key, job] of Object.entries(m.queue)) {
    if (!object(job) || !['pending', 'prepared', 'done'].includes(job.status) || !Object.hasOwn(m.accounts, job.accountId) ||
        !Object.hasOwn(m.products, job.productId) || key !== keyFor(job.productId, job.accountId) || !integer(job.attempts)) throw new Error('Ungültiger Warteschlangeneintrag');
    if (job.status !== 'pending' && (!integer(job.plan?.targetQuantity) || job.plan.targetQuantity !== (m.accounts[job.accountId].cart[`product:${job.productId}`] ?? 0))) throw new Error('Ungültiger gespeicherter Mengenplan');
  }
  for (const [key, product] of Object.entries(m.products)) {
    validateProduct(product);
    if (key !== product.id || accounts.some(a => !Object.hasOwn(m.queue, keyFor(product.id, a.id)))) throw new Error('Unvollständige Produktwarteschlange');
  }
  return m;
}

function limits(product, accountId) {
  for (const field of ['stock', 'maxPerOrder', 'globalLimit']) {
    if (!integer(product[field])) throw new Error(`Unbekanntes oder ungültiges Mengenlimit: ${field}`);
  }
  const custom = product.accountLimits?.[accountId];
  if (custom !== undefined && !integer(custom)) throw new Error('Ungültiges Kontolimit');
  return { total: Math.min(product.stock, product.globalLimit), personal: Math.min(product.maxPerOrder, custom ?? product.maxPerOrder) };
}

function planFor(m, product, accountId) {
  const { total, personal } = limits(product, accountId);
  const cartKey = `product:${product.id}`;
  const current = m.accounts[accountId].cart[cartKey] ?? 0;
  const used = Object.values(m.accounts).reduce((sum, a) => sum + (a.cart[cartKey] ?? 0), 0);
  if (used > total || current > personal) throw new Error('Bestehende Mengen überschreiten aktualisiertes Limit; manuelle Klärung erforderlich');
  const addQuantity = Math.min(personal - current, total - used);
  return { existingQuantity: current, addQuantity, targetQuantity: current + addQuantity, globalLimit: total };
}

function history(a, job, event, extra = {}) {
  a.history.push({ time: new Date().toISOString(), productId: job.productId, event, ...extra });
}

function fresh(product, currentProducts, at, maxAge) {
  const age = at.getTime() - Date.parse(product.source?.observedAt);
  return currentProducts.has(product.id) && product.source?.provider === 'brack' &&
    Number.isFinite(age) && age >= 0 && age <= maxAge &&
    product.limitSource === 'local-test-policy' && Date.parse(product.limitsExpireAt) > at.getTime();
}

function deferStale(job, summary) {
  job.lastError = 'Keine aktuellen Produktdaten mit gültigen Testlimits; Vorbereitung gesperrt';
  job.lastStage = 'freshness';
  summary.limited++;
}

// Shared scan and durable queue; the exclusive store lock covers the whole run.
export async function runFourMonitor({ scanner, accounts, adapter, telegram, store, log = jsonLogger,
  now = () => new Date(), maxSnapshotAgeMs = 60000 }) {
  validateAccounts(accounts);
  const readOnly = scanner.mode === 'read-only';
  if (!integer(maxSnapshotAgeMs) || maxSnapshotAgeMs === 0) throw new Error('Ungültige Aktualitätsgrenze');
  const orderedAccounts = [...accounts].sort((a, b) => a.id.localeCompare(b.id));
  return store.locked(async () => {
    const state = await store.load();
    if (state.multi && (state.multi.operationMode === 'read-only') !== readOnly) throw new Error('Getrennten Zustand für Lese- und Offline-Modus verwenden');
    const m = initialise(state, orderedAccounts);
    if (readOnly) {
      m.operationMode = 'read-only';
      m.observations ??= {};
      if (!object(m.observations) || Object.entries(m.observations).some(([id, o]) => !/^[1-9]\d*$/.test(id) ||
          !object(o) || !Number.isFinite(Date.parse(o.firstSeenAt)) || !Number.isFinite(Date.parse(o.lastSeenAt)) ||
          typeof o.selected !== 'boolean') || Object.keys(m.products).some(id => !Object.hasOwn(m.observations, id))) {
        throw new Error('Ungültige Artikelbeobachtungen');
      }
      for (const job of Object.values(m.queue).filter(j => j.status !== 'pending')) {
        validateProduct(job.preparedProduct);
        if (job.preparedProduct.id !== job.productId || job.cart?.accountId !== job.accountId ||
            job.cart?.productId !== job.productId || job.cart?.mode !== 'mock' ||
            job.cart?.targetQuantity !== job.plan.targetQuantity) throw new Error('Ungültige gespeicherte Vorbereitung');
      }
    }
    const summary = { discovered: 0, completed: 0, limited: 0, failed: 0 };
    const blockedProducts = new Set();
    const currentProducts = new Set();
    let products = [];
    try {
      products = await scanner.scan();
      if (!Array.isArray(products)) throw new Error('Scanner muss eine Produktliste liefern');
      if (readOnly) m.lastScan = { status: 'ok', at: now().toISOString(), count: products.length };
    } catch (err) {
      products = []; summary.failed++;
      if (readOnly) m.lastScan = { status: 'failed', at: now().toISOString(), error: err.message };
      if (readOnly && err.name === 'AccessRestrictedError') summary.halted = true;
      if (readOnly && integer(err.retryAfterMs)) summary.retryAfterMs = err.retryAfterMs;
      log({ event: 'scan_failed', error: err.message });
    }
    for (const product of products) {
      try {
        validateProduct(product);
        if (readOnly) {
          if (!/^[1-9]\d*$/.test(product.id)) throw new Error('BRACK-Artikelnummer erforderlich');
          const prior = m.observations[product.id];
          m.observations[product.id] = { firstSeenAt: prior?.firstSeenAt ?? now().toISOString(),
            lastSeenAt: now().toISOString(), selected: priority(product) > 0 };
        }
        if (!priority(product)) { if (readOnly) blockedProducts.add(product.id); continue; }
        if (!readOnly) for (const a of orderedAccounts) limits(product, a.id);
        if (!Object.hasOwn(m.products, product.id)) {
          Object.defineProperty(m.products, product.id, { value: product, enumerable: true, writable: true, configurable: true });
          for (const a of orderedAccounts) m.queue[keyFor(product.id, a.id)] = { productId: product.id, accountId: a.id, status: 'pending', attempts: 0 };
          summary.discovered++;
        } else m.products[product.id] = product;
        currentProducts.add(product.id);
      } catch (err) {
        if (typeof product?.id === 'string') blockedProducts.add(product.id);
        summary.failed++;
        log({ event: 'invalid_product', error: err.message });
      }
    }
    if (readOnly) summary.scanned = products.length;
    // Never continue with stale limits when the latest snapshot is invalid.
    // Lowered limits cannot silently remove previously prepared positions.
    for (const product of Object.values(m.products)) {
      if (blockedProducts.has(product.id)) continue;
      try { for (const a of orderedAccounts) planFor(m, product, a.id); }
      catch (err) {
        blockedProducts.add(product.id);
        if (readOnly && ['stock', 'maxPerOrder', 'globalLimit'].some(k => !integer(product[k]))) summary.limited++;
        else summary.failed++;
        if (readOnly) m.observations[product.id].blockedReason = err.message;
        log({ event: 'product_limits_blocked', productId: product.id, error: err.message });
      }
    }
    await store.save(state);
    const blockedAccounts = new Set();
    const jobs = Object.entries(m.queue).filter(([, j]) => j.status !== 'done')
      .sort(([, a], [, b]) => priority(m.products[b.productId]) - priority(m.products[a.productId]));
    for (const [key, job] of jobs) {
      if (blockedAccounts.has(job.accountId) || blockedProducts.has(job.productId)) continue;
      const account = orderedAccounts.find(a => a.id === job.accountId);
      const local = m.accounts[job.accountId];
      const product = m.products[job.productId];
      if (readOnly && job.status === 'pending' && !fresh(product, currentProducts, now(), maxSnapshotAgeMs)) {
        deferStale(job, summary);
        continue;
      }
      job.attempts++;
      let stage = 'login';
      try {
        if (job.status === 'pending') {
          if (!local.session) {
            const session = await adapter.login(account);
            if (session?.mode !== 'mock' || session.accountId !== account.id) throw new Error('Sitzung gehört nicht zum Konto');
            local.session = session;
            history(local, job, 'login_succeeded');
            await store.save(state);
          }
          stage = 'cart';
          // Check again after an awaited session operation, immediately before planning.
          if (readOnly && !fresh(product, currentProducts, now(), maxSnapshotAgeMs)) {
            deferStale(job, summary);
            await store.save(state);
            continue;
          }
          const plan = planFor(m, product, account.id);
          if (plan.targetQuantity === 0) {
            job.lastError = 'Kein verfügbares kontenübergreifendes Mengenbudget';
            job.lastStage = 'limit';
            local.lastError = { stage: 'limit', productId: product.id, message: job.lastError };
            history(local, job, 'quantity_limited');
            summary.limited++;
            await store.save(state);
            continue;
          }
          const result = await adapter.prepare({ account, session: local.session, product, targetQuantity: plan.targetQuantity, idempotencyKey: `cart:${key}` });
          if (result?.mode !== 'mock' || result.accountId !== account.id || result.productId !== product.id || result.targetQuantity !== plan.targetQuantity) throw new Error('Ungültige Warenkorbbestätigung');
          local.cart[`product:${product.id}`] = plan.targetQuantity;
          job.plan = plan;
          job.cart = result;
          job.preparedProduct = structuredClone(product);
          job.status = 'prepared';
          history(local, job, 'cart_prepared', { targetQuantity: plan.targetQuantity });
          await store.save(state);
        }
        stage = 'telegram';
        job.notification = await telegram.send(preparationMessage({ account, product: job.preparedProduct ?? product, plan: job.plan }), { idempotencyKey: `telegram:${key}` });
        job.status = 'done';
        delete job.lastError;
        delete job.lastStage;
        local.lastError = null;
        history(local, job, 'completed');
        summary.completed++;
      } catch (err) {
        job.lastError = err.message;
        job.lastStage = stage;
        local.lastError = { stage, productId: product.id, message: err.message };
        history(local, job, 'failed', { stage, error: err.message });
        if (stage === 'login') { local.session = null; blockedAccounts.add(account.id); }
        summary.failed++;
        log({ event: 'account_job_failed', accountId: account.id, productId: product.id, stage, error: err.message });
      }
      await store.save(state);
    }
    await store.save(state);
    log({ event: 'four_account_run_completed', mode: readOnly ? 'read-only' : 'mock', ...summary });
    return summary;
  });
}
