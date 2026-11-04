// Entirely synthetic API contract and responses. NOT observed BRACK endpoints.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionVault } from '../../src/brack/session-vault.js';
import { AccountStore } from '../../src/brack/account-store.js';
import { RealAccountAdapter } from '../../src/brack/real-account-adapter.js';
import { hash, realAccounts } from '../../src/brack/account-contract.js';
import { BrackScanner } from '../../src/brack/scanner.js';
import { runFourMonitor } from '../../src/four-monitor.js';
import { listing, rawProduct } from './brack.js';

export const contract = () => ({
  version: 1, origin: 'https://www.brack.ch', reviewed: true, reviewedAt: '2026-11-04T12:00:00Z',
  limitSemantics: 'total-including-all-four-carts',
  identity: { path: '/synthetic/identity', subject: '/subject', cartId: '/cart' },
  cart: { path: '/synthetic/cart', cartId: '/cart', items: '/items', productId: '/id', quantity: '/quantity', complete: '/complete' },
  product: { path: '/synthetic/products/{productId}', productId: '/id', stock: '/stock',
    maxPerOrder: '/maxPerOrder', accountLimit: '/accountLimit', globalLimit: '/globalLimit', limitsComplete: '/complete' },
  write: { path: '/synthetic/cart/positions/{productId}', method: 'PUT', semantics: 'set-total',
    precondition: 'If-Match', quantityField: 'quantity', csrfCookie: 'csrf', csrfHeader: 'X-CSRF-Token' }
});
export const session = id => ({ cookies: [
  { name: 'session', value: id, domain: 'www.brack.ch', path: '/', secure: true, httpOnly: true, expires: -1, sameSite: 'Lax' },
  { name: 'csrf', value: 'SYNTHETIC-CSRF', domain: 'www.brack.ch', path: '/', secure: true, httpOnly: false, expires: -1, sameSite: 'Lax' }
], origins: [] });

export async function accountSetup(t, { write = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'brack-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = new SessionVault(directory);
  await vault.initialise();
  const accounts = realAccounts(), c = contract(), requests = [], deliveries = [], events = [];
  const server = Object.fromEntries(accounts.map((a, i) => [a.id, {
    subject: 'synthetic-subject-' + i, cart: 'synthetic-cart-' + i, items: {}, revision: 1
  }]));
  const time = new Date('2026-11-04T12:00:00Z');
  const limits = { stock: 10, maxPerOrder: 4, accountLimit: 3, globalLimit: 7, complete: true };
  const hooks = {};
  for (const a of accounts) {
    await vault.save(a.id + '/session.json', session(a.id));
    await vault.save(a.id + '/binding.json', { version: 1, subject: hash(server[a.id].subject), cart: hash(server[a.id].cart) });
  }
  await vault.save('contract.json', c);
  const bindings = await vault.bindings();
  const grant = { version: 1, approved: true, operation: 'fill-carts-only', contractSha256: hash(JSON.stringify(c)),
    bindings, expiresAt: new Date(time.getTime() + 3600000).toISOString() };
  if (write) await vault.save('write-approval.json', grant);
  const requestFactory = async ({ storageState }) => {
    const id = storageState.cookies.find(cookie => cookie.name === 'session').value;
    return {
      storageState: async () => structuredClone(storageState),
      dispose: async () => {},
      fetch: async (url, options) => {
        const path = new URL(url).pathname;
        const req = { id, path, ...options };
        requests.push(req); events.push(options.method + ':' + id + ':' + path);
        const custom = await hooks.request?.(req);
        if (custom instanceof Error) throw custom;
        let status = custom?.status ?? 200, json = custom?.json, headers = custom?.headers ?? {};
        const s = server[id];
        if (!custom) {
          if (path === '/synthetic/identity') json = { subject: s.subject, cart: s.cart };
          else if (path === '/synthetic/cart') {
            json = { cart: s.cart, complete: true, items: Object.entries(s.items).map(([id, quantity]) => ({ id, quantity })) };
            headers.etag = '"' + s.revision + '"';
          } else if (options.method === 'PUT') {
            if (options.headers['If-Match'] !== '"' + s.revision + '"') status = 412;
            else {
              s.items[path.split('/').at(-1)] = options.data.quantity; s.revision++;
              await hooks.afterPut?.(req);
              json = {};
            }
          } else json = { id: path.split('/').at(-1), ...limits };
        }
        return { status: () => status, headers: () => ({ 'content-type': 'application/json', ...headers }),
          body: async () => Buffer.from(custom?.body ?? JSON.stringify(json)), dispose: async () => {} };
      }
    };
  };
  const adapter = new RealAccountAdapter({ vault, contract: c, requestFactory, write, now: () => time });
  t.after(() => adapter.close());
  let products = [rawProduct()];
  const deps = {
    accounts, adapter, scanner: new BrackScanner({ now: () => time, http: { get: async () => { events.push('scan'); return listing(products); } } }),
    telegram: { mode: 'test', send: async text => { events.push('send'); deliveries.push(text); return { mode: 'test', simulated: true }; } },
    store: new AccountStore(vault, adapter.operation), now: () => time, log: () => {}
  };
  const locked = fn => vault.locked(async () => { await adapter.initialise(); return fn(); });
  return { directory, vault, accounts, contract: c, bindings, grant, adapter, deps, time, server, limits, requests, deliveries, events, hooks,
    locked, run: () => locked(() => runFourMonitor(deps)), products: p => { products = p; },
    state: () => deps.store.load() };
}
