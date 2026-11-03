import { validateTelegramConfig } from './config.js';

const SAFE_CODES = new Set(['rate_limited', 'rejected', 'unauthorized', 'forbidden',
  'network_before_send', 'delivery_unknown', 'invalid_message']);

export class TelegramDeliveryError extends Error {
  constructor(code, disposition, retryAfterMs = 0) {
    if (!SAFE_CODES.has(code) || !['retry', 'permanent', 'uncertain'].includes(disposition) ||
        !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) throw new Error('Ungültige Zustellfehler-Klassifikation');
    super('Telegram: ' + code);
    this.name = 'TelegramDeliveryError';
    Object.assign(this, { code, disposition, retryAfterMs });
  }
}

export class TelegramClient {
  mode = 'telegram';
  #token;
  #chatId;
  #fetch;
  constructor(config, { fetchImpl = fetch, timeoutMs = 10000, maxBytes = 65536 } = {}) {
    const validated = validateTelegramConfig(config);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1_000_000) throw new Error('Ungültige Telegram-HTTP-Grenzen');
    this.#token = validated.botToken;
    this.#chatId = validated.chatId;
    this.#fetch = fetchImpl;
    Object.assign(this, { timeoutMs, maxBytes });
  }

  // Exactly one POST per call. Durable retry decisions belong to the outbox.
  async send(text) {
    if (typeof text !== 'string' || !text.trim() || text.length > 4096) throw new TelegramDeliveryError('invalid_message', 'permanent');
    let response;
    try {
      response = await this.#fetch('https://api.telegram.org/bot' + this.#token + '/sendMessage', {
        method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ chat_id: this.#chatId, text, link_preview_options: { is_disabled: true } })
      });
    } catch (err) {
      const beforeSend = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'].includes(err?.cause?.code);
      throw new TelegramDeliveryError(beforeSend ? 'network_before_send' : 'delivery_unknown', beforeSend ? 'retry' : 'uncertain');
    }
    let data;
    try {
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new Error('content-type');
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > this.maxBytes) throw new Error('size');
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new TelegramDeliveryError('delivery_unknown', 'uncertain');
    }
    if (response.status === 200 && data?.ok === true && Number.isSafeInteger(data.result?.message_id) && data.result.message_id > 0) {
      const chat = data.result.chat;
      const correctChat = this.#chatId.startsWith('@') ?
        typeof chat?.username === 'string' && chat.username.toLowerCase() === this.#chatId.slice(1).toLowerCase() :
        String(chat?.id) === this.#chatId;
      if (correctChat) return { mode: 'telegram', messageId: data.result.message_id };
    }
    if (data?.ok === false && data.error_code === 429 && [200, 429].includes(response.status)) {
      const seconds = data.parameters?.retry_after;
      const header = response.headers.get('retry-after');
      const headerMs = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Date.parse(header) - Date.now() : 0;
      if ((seconds !== undefined && (!Number.isSafeInteger(seconds) || seconds < 0)) ||
          (header !== null && !Number.isFinite(headerMs))) throw new TelegramDeliveryError('rate_limited', 'permanent');
      const wait = Math.max(Number.isSafeInteger(seconds) && seconds >= 0 ? seconds * 1000 : 0, Number.isFinite(headerMs) ? headerMs : 0);
      if (Number.isSafeInteger(wait) && wait >= 0) throw new TelegramDeliveryError('rate_limited', 'retry', wait);
      throw new TelegramDeliveryError('rate_limited', 'permanent');
    }
    if (data?.ok === false && [400, 401, 403, 404].includes(data.error_code) && [200, data.error_code].includes(response.status)) {
      const code = ({ 401: 'unauthorized', 403: 'forbidden' })[data.error_code] ?? 'rejected';
      throw new TelegramDeliveryError(code, 'permanent');
    }
    // A 5xx, redirect, malformed response or timeout may follow a successful send.
    throw new TelegramDeliveryError('delivery_unknown', 'uncertain');
  }
}
