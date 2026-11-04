import { priority } from '../filter.js';
import { jsonLogger } from '../monitor.js';
import { discoveryMessage, discoveryProduct } from './message.js';
import { TelegramDeliveryError } from './client.js';

const record = x => x && typeof x === 'object' && !Array.isArray(x);
const integer = x => Number.isSafeInteger(x) && x >= 0;
const date = x => typeof x === 'string' && Number.isFinite(Date.parse(x));
const statuses = ['pending', 'sending', 'sent', 'uncertain', 'failed', 'suppressed'];
const safeErrors = ['rate_limited', 'rejected', 'unauthorized', 'forbidden', 'network_before_send',
  'delivery_unknown', 'invalid_message', 'delivery_unknown_after_restart'];

function initialise(state, mode, source) {
  if (state.multi || Object.keys(state.products).length) throw new Error('Separaten Zustand für Produktmeldungen verwenden');
  if (!Object.hasOwn(state, 'discovery')) state.discovery = {
    version: 1, mode, source, initialScanAt: null, pausedUntil: null, entries: {}
  };
  const box = state.discovery;
  if (!record(box) || box.version !== 1 || box.mode !== mode || box.source !== source || !record(box.entries) ||
      (box.initialScanAt !== null && !date(box.initialScanAt)) || (box.pausedUntil !== null && !date(box.pausedUntil))) {
    throw new Error('Ungültiger oder inkompatibler Telegram-Zustand; kein automatisches Zurücksetzen');
  }
  for (const [id, entry] of Object.entries(box.entries)) {
    if (!record(entry) || !statuses.includes(entry.status) || !integer(entry.attempts) || !date(entry.firstSeenAt) ||
        entry.product?.id !== id || !date(entry.nextAttemptAt) ||
        entry.text !== discoveryMessage(entry.product, { discoveredAt: entry.firstSeenAt, cartResults: entry.cartResults }) ||
        (entry.lastError !== undefined && !safeErrors.includes(entry.lastError)) ||
        (entry.status === 'sending' && !date(entry.attemptStartedAt)) ||
        (entry.status === 'sent' && !date(entry.sentAt)) ||
        (entry.status === 'sent' && !date(entry.acknowledgedAt) && !(mode === 'test' ?
          entry.receipt?.mode === 'test' && entry.receipt.simulated === true :
          entry.receipt?.mode === 'telegram' && integer(entry.receipt.messageId) && entry.receipt.messageId > 0))) {
      throw new Error('Ungültiger gespeicherter Telegram-Auftrag');
    }
  }
  return box;
}

// One durable record per BRACK article, independently of all four mock carts.
export async function runDiscoveryMonitor({ scanner, telegram, store, source = 'brack', now = () => new Date(),
  random = Math.random, maxAttempts = 5, baseline = false, retryFailed, acknowledgeUncertain, log = jsonLogger, cartProcessor }) {
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
        if (!priority(p)) continue;
        const product = discoveryProduct(p);
        if (Object.hasOwn(box.entries, product.id)) continue;
        const firstSeenAt = now().toISOString();
        const text = discoveryMessage(product, { discoveredAt: firstSeenAt });
        box.entries[product.id] = { product, text, firstSeenAt, nextAttemptAt: firstSeenAt,
          status: baseline ? 'suppressed' : 'pending', attempts: 0 };
        summary.discovered++;
      } catch { summary.failed++; log({ event: 'discovery_product_invalid' }); }
    }
    // Discovery and recovery must be durable before any outbound POST.
    await store.save(state);
    if (cartProcessor && summary.scanSucceeded) {
      Object.assign(summary, await cartProcessor.process({ state, box, currentProducts: products, store, now }));
      for (const entry of Object.values(box.entries)) {
        if (entry.status === 'pending' && entry.attempts === 0) {
          entry.text = discoveryMessage(entry.product, { discoveredAt: entry.firstSeenAt, cartResults: entry.cartResults });
        }
      }
      await store.save(state);
    }
    const queue = Object.values(box.entries).filter(e => e.status === 'pending' && (!cartProcessor || e.cartResults !== undefined))
      .sort((a, b) => priority(b.product) - priority(a.product) || Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt));
    for (const entry of queue) {
      if (Date.parse(box.pausedUntil) > now().getTime() || Date.parse(entry.nextAttemptAt) > now().getTime()) continue;
      if (entry.attempts >= maxAttempts) { entry.status = 'failed'; summary.failed++; await store.save(state); continue; }
      entry.status = 'sending'; entry.attempts++; entry.attemptStartedAt = now().toISOString();
      await store.save(state);
      let receipt;
      try {
        receipt = await telegram.send(entry.text);
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
