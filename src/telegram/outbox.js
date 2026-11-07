import { notificationSelected } from '../filter.js';
import { jsonLogger } from '../monitor.js';
import { discoveryMessage, discoveryProduct } from './message.js';
import { TelegramDeliveryError } from './client.js';

const record = x => x && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const date = x => typeof x === 'string' && Number.isFinite(Date.parse(x));
const statuses = ['pending', 'sending', 'sent', 'uncertain', 'failed', 'suppressed'];
const safeErrors = ['rate_limited', 'rejected', 'unauthorized', 'forbidden', 'network_before_send',
  'delivery_unknown', 'invalid_message', 'delivery_unknown_after_restart'];

// Validate the original persisted v1 payload before migrating it. Never resend it.
function legacyMessage(p, at, results) {
  discoveryProduct(p);
  let text = 'Neues BRACK Pokémon-TCG-Produkt\nProdukt: ' + p.name +
    '\nArtikelnummer: ' + p.id + '\nSprache: ' + ({ en: 'Englisch', de: 'Deutsch' })[p.language] +
    '\nLagerbestand (bei Erkennung): ' + (p.stock === null ? 'unbekannt' : p.stock) +
    '\nLink: ' + p.url + (at ? '\nErkannt am: ' + at : '');
  if (results !== undefined) {
    if (!Array.isArray(results) || results.length !== 4) throw new Error('Ungültiger gespeicherter Auftrag');
    text += '\n\nBRACK-Konten (kein Checkout):';
    for (const [i, r] of results.entries()) {
      const label = { 'read-only': 'nur gelesen, keine Änderung', verified: 'Warenkorb geprüft',
        blocked: 'gesperrt, nicht befüllt', failed: 'Lesen fehlgeschlagen', uncertain: 'Ausgang unklar, keine Wiederholung' }[r.status];
      if (r.accountId !== 'brack-account-' + (i + 1) || !label) throw new Error('Ungültiger gespeicherter Auftrag');
      text += '\n' + r.accountId + ': ' + label + (r.quantity !== undefined ? '; Menge ' + r.quantity : '') +
        (r.status === 'read-only' && r.targetQuantity !== undefined ? '; möglicher Zielwert ' + r.targetQuantity : '') +
        (r.checkedAt ? '; geprüft ' + r.checkedAt : '');
    }
  }
  return text;
}

function initialise(state, mode, source) {
  if (state.multi || Object.keys(state.products).length) throw new Error('Separaten Zustand für Produktmeldungen verwenden');
  if (!Object.hasOwn(state, 'discovery')) state.discovery = {
    version: 2, mode, source, initialScanAt: null, pausedUntil: null, entries: {}, seen: {}, needsBaseline: false, nextOrder: 0
  };
  const box = state.discovery;
  if (!record(box) || ![1, 2].includes(box.version) || box.mode !== mode || box.source !== source || !record(box.entries) ||
      (box.initialScanAt !== null && !date(box.initialScanAt)) || (box.pausedUntil !== null && !date(box.pausedUntil))) {
    throw new Error('Ungültiger oder inkompatibler Telegram-Zustand; kein automatisches Zurücksetzen');
  }
  const legacy = box.version === 1;
  for (const [id, entry] of Object.entries(box.entries)) {
    if (!record(entry) || !statuses.includes(entry.status) || !integer(entry.attempts) || !date(entry.firstSeenAt) ||
        entry.product?.id !== id || !date(entry.nextAttemptAt) ||
        (legacy ? entry.text !== legacyMessage(entry.product, entry.firstSeenAt, entry.cartResults) : entry.text !== discoveryMessage(entry.product)) ||
        (entry.lastError !== undefined && !safeErrors.includes(entry.lastError)) ||
        (entry.status === 'sending' && !date(entry.attemptStartedAt)) ||
        (entry.status === 'sent' && !date(entry.sentAt)) ||
        (entry.status === 'sent' && !date(entry.acknowledgedAt) && !(mode === 'test' ?
          entry.receipt?.mode === 'test' && entry.receipt.simulated === true :
          entry.receipt?.mode === 'telegram' && integer(entry.receipt.messageId) && entry.receipt.messageId > 0))) {
      throw new Error('Ungültiger gespeicherter Telegram-Auftrag');
    }
  }
  if (legacy) {
    box.version = 2; box.needsBaseline = true; box.seen = {}; box.nextOrder = 0;
    for (const [id, entry] of Object.entries(box.entries)) {
      entry.queueOrder = box.nextOrder++;
      entry.legacyText = entry.text;
      entry.product = discoveryProduct(entry.product);
      entry.text = discoveryMessage(entry.product);
      delete entry.cartResults;
      box.seen[id] = { firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.firstSeenAt };
    }
  }
  if (!integer(box.nextOrder) || !record(box.seen) || typeof box.needsBaseline !== 'boolean' || Object.entries(box.seen).some(([id, value]) =>
      !/^[1-9]\d*$/.test(id) || !record(value) || !date(value.firstSeenAt) || !date(value.lastSeenAt))) {
    throw new Error('Ungültiger gespeicherter Artikelbestand');
  }
  const orders = Object.values(box.entries).map(e => e.queueOrder);
  if (orders.some(n => !integer(n) || n >= box.nextOrder) || new Set(orders).size !== orders.length) throw new Error('Ungültiger gespeicherter Auftragsrang');
  return box;
}


// One durable record per BRACK article, independently of all four mock carts.
export async function runDiscoveryMonitor({ scanner, telegram, store, source = 'brack', now = () => new Date(),
  random = Math.random, maxAttempts = 5, baseline = false, retryFailed, acknowledgeUncertain, log = jsonLogger }) {
  if (scanner.mode !== 'read-only' || !['telegram', 'test'].includes(telegram.mode) ||
      !['brack', 'fixture'].includes(source) || (source === 'fixture' && telegram.mode === 'telegram') ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error('Ungültiger Benachrichtigungsmodus');
  if (retryFailed && acknowledgeUncertain) throw new Error('Nur eine manuelle Auftragsaktion je Aufruf');
  return store.locked(async () => {
    const state = await store.load();
    const box = initialise(state, telegram.mode, source);
    const summary = { discovered: 0, sent: 0, simulated: 0, failed: 0, uncertain: 0, scanned: 0, scanSucceeded: false };
    if (baseline && box.initialScanAt !== null) throw new Error('Baseline nur vor dem ersten erfolgreichen Scan zulässig');
    if (retryFailed) {
      const entry = box.entries[retryFailed];
      if (entry?.status !== 'failed') throw new Error('Nur bestätigte fehlgeschlagene Zustellungen können erneut versucht werden');
      entry.status = 'pending'; entry.attempts = 0; entry.nextAttemptAt = now().toISOString();
      entry.retriedManuallyAt = now().toISOString();
    }
    if (acknowledgeUncertain) {
      const entry = box.entries[acknowledgeUncertain];
      if (entry?.status !== 'uncertain') throw new Error('Nur unklare Zustellungen können manuell als zugestellt bestätigt werden');
      entry.status = 'sent'; entry.sentAt = now().toISOString(); entry.acknowledgedAt = entry.sentAt;
      delete entry.lastError;
    }
    // A prior process may have died after Telegram accepted the POST. Never resend blindly.
    for (const entry of Object.values(box.entries)) {
      if (entry.status === 'sending') {
        entry.status = 'uncertain'; entry.lastError = 'delivery_unknown_after_restart';
        summary.uncertain++;
        log({ event: 'telegram_delivery_uncertain', article: entry.product.id, code: entry.lastError });
      }
    }
    let products = [];
    try {
      products = await scanner.scan();
      if (!Array.isArray(products)) throw new Error('Scanner muss eine Produktliste liefern');
      box.lastScan = { status: 'ok', at: now().toISOString(), count: products.length };
      box.initialScanAt ??= now().toISOString();
      summary.scanSucceeded = true;
    } catch (err) {
      products = []; summary.failed++;
      // Scanner failures are separate from the credential-bearing Telegram transport.
      box.lastScan = { status: 'failed', at: now().toISOString() };
      if (err.name === 'AccessRestrictedError') summary.halted = true;
      if (integer(err.retryAfterMs)) summary.retryAfterMs = err.retryAfterMs;
      log({ event: 'discovery_scan_failed', accessRestricted: summary.halted === true });
    }
    summary.scanned = products.length;
    for (const p of products) {
      try {
        if (!/^[1-9]\d*$/.test(p.id)) throw new Error('Ungültige Artikelnummer');
        const prior = box.seen[p.id];
        const known = !!prior || Object.hasOwn(box.entries, p.id);
        const firstSeenAt = prior?.firstSeenAt ?? now().toISOString();
        if (!notificationSelected(p)) {
          box.seen[p.id] = { firstSeenAt, lastSeenAt: now().toISOString() };
          continue;
        }
        const product = discoveryProduct(p);
        const text = discoveryMessage(product);
        box.seen[p.id] = { firstSeenAt, lastSeenAt: now().toISOString() };
        if (Object.hasOwn(box.entries, product.id)) {
          const entry = box.entries[product.id];
          if (entry.status === 'pending' && !entry.product.imageUrl && product.imageUrl) {
            entry.product.imageUrl = product.imageUrl;
            delete entry.blockedReason;
          }
          continue;
        }
        const suppressed = baseline || box.needsBaseline || known;
        box.entries[product.id] = { product, text, firstSeenAt, nextAttemptAt: firstSeenAt,
          status: suppressed ? 'suppressed' : 'pending', attempts: 0, queueOrder: box.nextOrder++ };
        if (!suppressed) {
          summary.discovered++;
          log({ event: 'discovery_product_detected', article: product.id, firstSeenAt });
        }
      } catch { summary.failed++; log({ event: 'discovery_product_invalid' }); }
    }
    if (summary.scanSucceeded) box.needsBaseline = false;
    // Discovery and recovery must be durable before any outbound POST.
    await store.save(state);
    // All supported languages use the same chronological queue, with no language sort.
    const queue = Object.values(box.entries).filter(e => e.status === 'pending')
      .sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt) || a.queueOrder - b.queueOrder);
    for (const entry of queue) {
      if (!entry.product.imageUrl) {
        if (entry.blockedReason !== 'image_missing') log({ event: 'discovery_image_missing', article: entry.product.id });
        entry.blockedReason = 'image_missing';
        await store.save(state);
        continue;
      }
      if (Date.parse(box.pausedUntil) > now().getTime() || Date.parse(entry.nextAttemptAt) > now().getTime()) continue;
      if (entry.attempts >= maxAttempts) { entry.status = 'failed'; summary.failed++; await store.save(state); continue; }
      entry.status = 'sending'; entry.attempts++; entry.attemptStartedAt = now().toISOString();
      await store.save(state);
      let receipt;
      try {
        receipt = await telegram.send(entry.text, { imageUrl: entry.product.imageUrl });
        if (telegram.mode === 'test' ? receipt?.mode !== 'test' || receipt.simulated !== true :
          receipt?.mode !== 'telegram' || !integer(receipt.messageId) || receipt.messageId < 1) throw new Error('Invalid receipt');
      } catch (err) {
        // Never persist raw transport errors, descriptions or request URLs (bot token!).
        const error = err instanceof TelegramDeliveryError ? err : new TelegramDeliveryError('delivery_unknown', 'uncertain');
        entry.lastError = error.code;
        summary.failed++;
        if (error.disposition === 'retry') {
          const backoff = Math.min(1800000, 30000 * 2 ** (entry.attempts - 1)) + Math.floor(Math.max(0, Math.min(1, random())) * 5000);
          const wait = Math.max(backoff, error.retryAfterMs);
          const due = new Date(now().getTime() + wait);
          if (!Number.isFinite(due.getTime())) { entry.status = 'failed'; summary.halted = true; }
          else {
            entry.status = entry.attempts < maxAttempts ? 'pending' : 'failed';
            entry.nextAttemptAt = due.toISOString(); box.pausedUntil = entry.nextAttemptAt;
          }
        } else {
          entry.status = error.disposition === 'uncertain' ? 'uncertain' : 'failed';
          if (entry.status === 'uncertain') summary.uncertain++;
        }
        if (['unauthorized', 'forbidden'].includes(error.code) ||
            (error.code === 'rate_limited' && error.disposition === 'permanent')) summary.halted = true;
        log({ event: 'telegram_delivery_failed', article: entry.product.id, code: error.code, status: entry.status });
        await store.save(state);
        if (error.disposition !== 'permanent' || summary.halted) break;
        continue;
      }
      // Save failure after success is fatal: disk stays 'sending', so restart holds it.
      entry.status = 'sent'; entry.sentAt = now().toISOString();
      entry.receipt = telegram.mode === 'test' ? { mode: 'test', simulated: true } : { mode: 'telegram', messageId: receipt.messageId };
      delete entry.lastError;
      await store.save(state);
      if (telegram.mode === 'test') summary.simulated++; else summary.sent++;
      log({ event: 'telegram_delivery_succeeded', article: entry.product.id, mode: telegram.mode });
    }
    summary.held = Object.values(box.entries).filter(e => ['uncertain', 'failed'].includes(e.status)).length;
    const pause = Date.parse(box.pausedUntil) - now().getTime();
    // Telegram throttles delivery, not BRACK discovery. Keep scanning during this pause.
    if (pause > 0) summary.telegramRetryAfterMs = pause;
    log({ event: 'discovery_run_completed', mode: telegram.mode, ...summary });
    return summary;
  });
}
