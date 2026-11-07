import { AccountError, endpoint, pointer, validateContract, REAL_ACCOUNT_IDS, hash, integer, fail } from './account-contract.js';
import { brackStorageState } from './session-vault.js';

const scalar = x => (typeof x === 'string' && x.length > 0 && x.length <= 200) ||
  (Number.isSafeInteger(x) && x > 0);
const strongEtag = s => typeof s === 'string' && /^"[^"\r\n]{1,200}"$/.test(s);

// No password automation, checkout API, add-delta operation or automatic retries.
// Every request uses one account's separate cookie jar. Only observed, reviewed
// GET endpoints are available. Cart mutations are not implemented.
export class RealAccountAdapter {
  mode = 'brack-real';
  #contexts = new Map();
  #running = false;
  constructor({ vault, contract, requestFactory, write = false, now = () => new Date() }) {
    this.vault = vault; this.contract = validateContract(contract);
    if (write !== false) fail('cart_writes_not_supported');
    this.requestFactory = requestFactory; this.now = now;
    this.operation = 'read-test';
  }
  async initialise() {
    this.vault.assertLocked();
    this.bindings = await this.vault.bindings();
    return this;
  }
  bindingFingerprint() {
    return hash(JSON.stringify({ bindings: this.bindings, contract: this.contract }));
  }
  async context(account) {
    this.vault.assertLocked();
    if (!REAL_ACCOUNT_IDS.includes(account?.id) || account.mode !== 'brack-real') fail('four_accounts_required');
    if (!this.#contexts.has(account.id)) {
      const storageState = brackStorageState(await this.vault.read(account.id + '/session.json'));
      const context = await this.requestFactory({ storageState, timeout: 15000, ignoreHTTPSErrors: false,
        extraHTTPHeaders: { accept: 'application/json', 'cache-control': 'no-cache' } });
      this.#contexts.set(account.id, context);
    }
    return this.#contexts.get(account.id);
  }
  async request(account, section) {
    if (!['identity', 'cart'].includes(section)) fail('cart_writes_not_supported');
    let response;
    try {
      const context = await this.context(account);
      response = await context.fetch(endpoint(this.contract[section].path), {
        method: 'GET',
        maxRedirects: 0, maxRetries: 0, timeout: 15000, failOnStatusCode: false
      });
      const status = response.status(), responseHeaders = response.headers();
      if (status === 429) {
        const raw = responseHeaders['retry-after'];
        let ms = /^\d+$/.test(raw ?? '') ? Number(raw) * 1000 : Date.parse(raw) - this.now().getTime();
        if (!Number.isFinite(ms) || ms < 0) ms = 60000;
        if (ms > 2147483647) throw new AccountError('brack_rate_limited', { halt: true });
        throw new AccountError('brack_rate_limited', { retryAfterMs: Math.max(30000, Math.ceil(ms)) });
      }
      if ([403, 503].includes(status)) throw new AccountError('brack_access_restricted', { halt: true });
      if (status === 401) fail('session_expired');
      if ([409, 412].includes(status)) fail('cart_changed');
      if (status < 200 || status > 299) fail('brack_request_failed');
      const length = Number(responseHeaders['content-length']);
      if (length > 2_000_000) fail('brack_schema_unknown');
      const body = await response.body();
      if (body.length > 2_000_000) fail('brack_schema_unknown');
      if (!(responseHeaders['content-type'] ?? '').includes('application/json')) {
        if (/captcha|access denied|zugriff verweigert|challenge/i.test(body.toString('utf8'))) {
          throw new AccountError('brack_access_restricted', { halt: true });
        }
        fail('brack_schema_unknown');
      }
      const json = body.length ? JSON.parse(body.toString('utf8')) : null;
      await this.vault.save(account.id + '/session.json', brackStorageState(await context.storageState()));
      return { json, headers: responseHeaders };
    } catch (e) {
      if (e instanceof AccountError) throw e;
      // Playwright errors include URLs, request headers and sometimes cookies.
      throw new AccountError('brack_read_failed');
    } finally { await response?.dispose(); }
  }
  async identity(account) {
    const { json } = await this.request(account, 'identity'), c = this.contract.identity;
    const subject = pointer(json, c.subject), cartId = pointer(json, c.cartId);
    if (!scalar(subject) || !scalar(cartId)) fail('brack_schema_unknown');
    const binding = this.bindings[account.id];
    if (hash(String(subject)) !== binding.subject || hash(String(cartId)) !== binding.cart) fail('account_identity_mismatch');
    return binding;
  }
  async readCart(account) {
    await this.identity(account);
    const { json, headers } = await this.request(account, 'cart'), c = this.contract.cart;
    const cartId = pointer(json, c.cartId), rows = pointer(json, c.items);
    if (!scalar(cartId) || hash(String(cartId)) !== this.bindings[account.id].cart ||
        pointer(json, c.complete) !== true || !Array.isArray(rows) || rows.length > 1000) fail('cart_not_verified');
    const items = {};
    for (const row of rows) {
      const id = String(pointer(row, c.productId)), quantity = pointer(row, c.quantity);
      if (!/^[1-9]\d*$/.test(id) || !integer(quantity) || quantity === 0 || Object.hasOwn(items, id)) fail('cart_not_verified');
      items[id] = quantity;
    }
    return { accountId: account.id, cart: this.bindings[account.id].cart, items,
      revision: strongEtag(headers.etag) ? headers.etag : null, observedAt: this.now().toISOString() };
  }
  async close() {
    for (const context of this.#contexts.values()) await context.dispose();
    this.#contexts.clear();
  }
  async runExclusive(action) {
    this.vault.assertLocked();
    if (this.#running) fail('accounts_locked');
    this.#running = true;
    try { return await action(); } finally { this.#running = false; }
  }
}

// Interactive login uses a fresh context, never one shared between accounts.
// Password/MFA stay in the browser. Only BRACK cookies/local storage are saved.
export async function enrolSession({ accountId, vault, contract, chromium, confirm }) {
  vault.assertLocked();
  if (!REAL_ACCOUNT_IDS.includes(accountId)) fail('four_accounts_required');
  validateContract(contract);
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto('https://www.brack.ch/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await confirm(); // Operator signs in manually; no scripted CAPTCHA solving.
    const c = contract.identity;
    const response = await context.request.get(endpoint(c.path), { maxRedirects: 0, maxRetries: 0, timeout: 15000 });
    try {
      if (response.status() !== 200 || !(response.headers()['content-type'] ?? '').includes('application/json')) fail('login_not_verified');
      const json = await response.json();
      const subject = pointer(json, c.subject), cart = pointer(json, c.cartId);
      if (!scalar(subject) || !scalar(cart)) fail('login_not_verified');
      const binding = { subject: hash(String(subject)), cart: hash(String(cart)) };
      const existing = await vault.bindings({ complete: false });
      if (existing[accountId] && JSON.stringify(existing[accountId]) !== JSON.stringify(binding)) fail('account_identity_mismatch');
      if (Object.entries(existing).some(([id, b]) => id !== accountId && (b.subject === binding.subject || b.cart === binding.cart))) fail('duplicate_brack_accounts');
      // A failure between these writes can require re-enrolment but cannot swap identities.
      await vault.save(accountId + '/binding.json', { version: 1, ...binding });
      await vault.save(accountId + '/session.json', brackStorageState(await context.storageState()));
    } finally { await response.dispose(); }
  } finally { await browser.close(); }
}
