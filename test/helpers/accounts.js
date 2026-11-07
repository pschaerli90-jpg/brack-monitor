// Entirely synthetic API contract and responses. NOT observed BRACK endpoints.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionVault } from '../../src/brack/session-vault.js';
import { AccountStore } from '../../src/brack/account-store.js';
import { RealAccountAdapter } from '../../src/brack/real-account-adapter.js';
import { hash, realAccounts } from '../../src/brack/account-contract.js';

export const contract = () => ({
  version: 1, origin: 'https://www.brack.ch', reviewed: true, reviewedAt: '2026-11-04T12:00:00Z',
  identity: { path: '/synthetic/identity', subject: '/subject', cartId: '/cart' },
  cart: { path: '/synthetic/cart', cartId: '/cart', items: '/items', productId: '/id', quantity: '/quantity', complete: '/complete' }
});
export const session = id => ({ cookies: [
  { name: 'session', value: id, domain: 'www.brack.ch', path: '/', secure: true, httpOnly: true, expires: -1, sameSite: 'Lax' }
], origins: [] });

export async function accountSetup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'brack-private-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const vault = new SessionVault(directory);
  await vault.initialise();
  const accounts = realAccounts(), c = contract(), requests = [];
  const server = Object.fromEntries(accounts.map((a, i) => [a.id, {
    subject: 'synthetic-subject-' + i, cart: 'synthetic-cart-' + i, items: {}, revision: 1
  }]));
  const time = new Date('2026-11-04T12:00:00Z');
  const hooks = {};
  for (const a of accounts) {
    await vault.save(a.id + '/session.json', session(a.id));
    await vault.save(a.id + '/binding.json', { version: 1, subject: hash(server[a.id].subject), cart: hash(server[a.id].cart) });
  }
  await vault.save('contract.json', c);
  const bindings = await vault.bindings();
  const requestFactory = async ({ storageState }) => {
    const id = storageState.cookies.find(cookie => cookie.name === 'session').value;
    return {
      storageState: async () => structuredClone(storageState), dispose: async () => {},
      fetch: async (url, options) => {
        const path = new URL(url).pathname, req = { id, path, ...options };
        requests.push(req);
        const custom = await hooks.request?.(req);
        if (custom instanceof Error) throw custom;
        let status = custom?.status ?? 200, json = custom?.json, headers = custom?.headers ?? {};
        const s = server[id];
        if (!custom) {
          if (path === '/synthetic/identity') json = { subject: s.subject, cart: s.cart };
          else if (path === '/synthetic/cart') {
            json = { cart: s.cart, complete: true, items: Object.entries(s.items).map(([id, quantity]) => ({ id, quantity })) };
            headers.etag = '"' + s.revision + '"';
          } else throw new Error('Unexpected synthetic read endpoint');
        }
        return { status: () => status, headers: () => ({ 'content-type': 'application/json', ...headers }),
          body: async () => Buffer.from(custom?.body ?? JSON.stringify(json)), dispose: async () => {} };
      }
    };
  };
  const adapter = new RealAccountAdapter({ vault, contract: c, requestFactory, now: () => time });
  t.after(() => adapter.close());
  const store = new AccountStore(vault, 'read-test');
  const locked = fn => vault.locked(async () => { await adapter.initialise(); return fn(); });
  return { directory, vault, accounts, contract: c, bindings, adapter, store, time, server, requests, hooks, requestFactory, locked,
    run: () => locked(() => store.locked(async () => { const state = await store.load(); await store.save(state); return state; })) };
}
