import { setTimeout as delay } from 'node:timers/promises';

export class AccessRestrictedError extends Error {
  constructor(message) { super(message); this.name = 'AccessRestrictedError'; }
}

// This transport exposes GET only. No cookies, authentication, cart or checkout API.
export class BrackHttp {
  constructor({ fetchImpl = fetch, sleep = delay, random = Math.random,
    timeoutMs = 15000, maxAttempts = 3, maxBytes = 2_000_000, maxBackoffMs = 30000 } = {}) {
    if (![timeoutMs, maxAttempts, maxBytes, maxBackoffMs].every(n => Number.isSafeInteger(n) && n > 0) || maxAttempts > 5) {
      throw new Error('Ungültige HTTP-Grenzen');
    }
    Object.assign(this, { fetchImpl, sleep, random, timeoutMs, maxAttempts, maxBytes, maxBackoffMs });
  }

  async get(url) {
    const target = new URL(url);
    if (target.origin !== 'https://www.brack.ch' || target.username || target.password ||
        target.pathname !== '/sport-freizeit/spielwaren/puzzles-spiele/spiele/sammelkarten' ||
        target.searchParams.get('sortProducts') !== 'newdesc' || target.searchParams.get('query') !== 'pokémon') {
      throw new Error('Nur die öffentliche BRACK-Sammelkartenliste mit newdesc ist erlaubt');
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let retryAfter = 0;
      try {
        const response = await this.fetchImpl(target.href, {
          method: 'GET', redirect: 'manual', credentials: 'omit',
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: { accept: 'text/html', 'user-agent': 'brack-monitor/0.2 (read-only)' }
        });
        if ([401, 403].includes(response.status)) {
          await response.body?.cancel();
          throw new AccessRestrictedError('BRACK verweigert den Zugriff; kein automatischer Wiederholungsversuch');
        }
        if ([408, 429].includes(response.status) || response.status >= 500) {
          const value = response.headers.get('retry-after');
          if (value !== null) {
            retryAfter = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
            if (!Number.isFinite(retryAfter)) retryAfter = 0;
          }
          await response.body?.cancel();
          const error = new Error('Temporärer BRACK-HTTP-Fehler ' + response.status);
          error.retryable = true;
          throw error;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error('BRACK-HTTP-Status ' + response.status + '; Weiterleitungen werden nicht verfolgt');
        }
        if (!response.headers.get('content-type')?.toLowerCase().includes('text/html')) {
          await response.body?.cancel();
          throw new Error('Unerwarteter BRACK-Inhaltstyp');
        }
        const chunks = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > this.maxBytes) throw new Error('BRACK-Antwort überschreitet Grössenlimit');
            chunks.push(value);
          }
        } finally { await reader.cancel(); reader.releaseLock(); }
        return Buffer.concat(chunks).toString('utf8');
      } catch (err) {
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = Math.ceil(retryAfter);
        const transient = err.retryable || err instanceof TypeError || ['TimeoutError', 'AbortError'].includes(err.name);
        if (!transient || attempt === this.maxAttempts || retryAfter > this.maxBackoffMs) throw err;
        await this.sleep(Math.max(0, retryAfter, Math.min(this.maxBackoffMs, 500 * 2 ** (attempt - 1) + this.random() * 250)));
      }
    }
  }
}
