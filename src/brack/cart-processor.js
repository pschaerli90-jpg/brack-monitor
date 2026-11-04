import { priority } from '../filter.js';
import { AccountError, integer, validateRealAccounts, fail } from './account-contract.js';
import { discoveryMessage } from '../telegram/message.js';

const statusValues = ['pending', 'read-only', 'verified', 'blocked', 'failed', 'mutating', 'uncertain'];
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && now.getTime() - Date.parse(at) >= 0 &&
  now.getTime() - Date.parse(at) <= 60000;
const codeFor = e => e instanceof AccountError ? e.code : 'account_operation_failed';
const quantity = (cart, id) => cart.items[id] ?? 0;
const expectedItems = (before, id, target) => ({ ...before.items, ...(target > 0 ? { [id]: target } : {}) });
const equalItems = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function validateCart(cart, account, now) {
  if (cart?.accountId !== account.id || !/^[a-f0-9]{64}$/.test(cart.cart) ||
      !cart.items || typeof cart.items !== 'object' || Array.isArray(cart.items) ||
      Object.entries(cart.items).some(([id, n]) => !/^[1-9]\d*$/.test(id) || !integer(n) || !n) ||
      !fresh(cart.observedAt, now)) fail('cart_not_verified');
}
function validateLimits(limits, product, account, now) {
  if (limits?.provider !== 'brack-authenticated' || limits.productId !== product.id ||
      limits.accountId !== account.id || !fresh(limits.observedAt, now) ||
      ['stock', 'maxPerOrder', 'accountLimit', 'globalLimit'].some(k => !integer(limits[k]))) fail('limits_unknown');
}
export function realQuantityPlan({ productId, accountId, carts, limits, consumed = 0 }) {
  const current = quantity(carts[accountId], productId);
  const used = Object.values(carts).reduce((n, c) => n + quantity(c, productId), 0);
  const personal = Math.min(limits.maxPerOrder, limits.accountLimit);
  const shared = Math.min(limits.stock, limits.globalLimit);
  if (!integer(used) || !integer(consumed) || current > personal || used > shared || consumed > shared) fail('limits_exceeded');
  // Existing positions across ALL four carts and additions in this run count.
  const addQuantity = Math.min(personal - current, Math.max(0, shared - used - consumed));
  return { existingQuantity: current, addQuantity, targetQuantity: current + addQuantity };
}

export function cartProcessor({ accounts, adapter }) {
  validateRealAccounts(accounts);
  return {
    async process({ state, box, currentProducts, store, now }) {
      const binding = adapter.bindingFingerprint(), mode = adapter.operation;
      if (box.cartBinding !== undefined && (box.cartBinding !== binding || !Object.hasOwn(state, 'realCarts'))) fail('real_cart_state_invalid');
      if (!Object.hasOwn(state, 'realCarts')) state.realCarts = {
        version: 1, binding, mode, products: {}, accountBlocks: {}, halted: false, pausedUntil: null
      };
      const m = state.realCarts;
      if (!m || m.version !== 1 || m.binding !== binding || m.mode !== mode || !m.products ||
          typeof m.products !== 'object' || Array.isArray(m.products) || !m.accountBlocks || Array.isArray(m.accountBlocks) ||
          typeof m.halted !== 'boolean' || (m.pausedUntil !== null && !Number.isFinite(Date.parse(m.pausedUntil)))) fail('real_cart_state_invalid');
      box.cartBinding = binding;
      for (const [id, p] of Object.entries(m.products)) {
        if (!/^[1-9]\d*$/.test(id) || !p.jobs || Object.keys(p.jobs).length !== 4 ||
            accounts.some(a => !statusValues.includes(p.jobs[a.id]?.status) || !integer(p.jobs[a.id].attempts) ||
              p.jobs[a.id].attempts > 1 ||
              (['pending', 'read-only'].includes(p.jobs[a.id].status) && p.jobs[a.id].attempts !== 0) ||
              (['mutating', 'uncertain'].includes(p.jobs[a.id].status) &&
                (p.jobs[a.id].attempts !== 1 || !p.jobs[a.id].intent || !integer(p.jobs[a.id].intent.targetQuantity))))) fail('real_cart_state_invalid');
      }
      const summary = { cartFailed: 0, cartVerified: 0, cartReadOnly: 0 };
      const pause = Date.parse(m.pausedUntil) - now().getTime();
      if (m.halted) return { ...summary, halted: true };
      if (pause > 0) return { ...summary, retryAfterMs: pause };
      const products = [...currentProducts].filter(p => priority(p) && box.entries[p.id]?.status !== 'suppressed')
        .sort((a, b) => priority(b) - priority(a));
      const save = () => store.save(state);
      const recordResults = (entry, p) => {
        entry.cartResults = accounts.map(a => {
          const job = p.jobs[a.id];
          return { accountId: a.id, status: ['pending', 'mutating'].includes(job.status) ? 'blocked' : job.status,
            ...(integer(job.after) ? { quantity: job.after } : {}),
            ...(integer(job.plan?.targetQuantity) ? { targetQuantity: job.plan.targetQuantity } : {}),
            ...(job.checkedAt ? { checkedAt: job.checkedAt } : {}) };
        });
        entry.text = discoveryMessage(entry.product, { discoveredAt: entry.firstSeenAt, cartResults: entry.cartResults });
      };
      const recordError = (job, account, error) => {
        job.code = codeFor(error); summary.cartFailed++;
        if (error instanceof AccountError && error.halt) { m.halted = true; summary.halted = true; }
        if (error instanceof AccountError && error.retryAfterMs > 0) {
          m.pausedUntil = new Date(now().getTime() + error.retryAfterMs).toISOString();
          summary.retryAfterMs = error.retryAfterMs;
        }
        if (['session_expired', 'account_identity_mismatch', 'vault_file_invalid'].includes(job.code)) m.accountBlocks[account.id] = job.code;
      };
      for (const product of products) {
        if (m.halted || summary.retryAfterMs) break;
        const entry = box.entries[product.id];
        if (!entry) continue;
        // Never rewrite a notification after an attempted Telegram POST.
        if (entry.attempts > 0 || entry.status !== 'pending') continue;
        m.products[product.id] ??= { jobs: Object.fromEntries(accounts.map(a => [a.id, { status: 'pending', attempts: 0 }])) };
        const p = m.products[product.id], carts = {};
        if (Object.values(p.jobs).every(j => !['pending', 'mutating'].includes(j.status))) {
          recordResults(entry, p); await save(); continue;
        }
        // Save discovery/jobs BEFORE any account operation.
        await save();
        for (const account of accounts) {
          const job = p.jobs[account.id];
          if (m.accountBlocks[account.id]) {
            if (job.status === 'pending') { job.status = 'blocked'; job.code = 'account_requires_login'; }
            continue;
          }
          try {
            carts[account.id] = await adapter.readCart(account);
            validateCart(carts[account.id], account, now());
            job.after = quantity(carts[account.id], product.id);
            job.checkedAt = carts[account.id].observedAt;
            if (job.status === 'mutating') {
              // A crashed PUT is reconciled by GET only, never repeated.
              const actual = carts[account.id], intent = job.intent;
              job.after = quantity(actual, product.id); job.checkedAt = now().toISOString();
              job.status = actual.cart === intent.before.cart &&
                equalItems(actual.items, expectedItems(intent.before, product.id, intent.targetQuantity)) ? 'verified' : 'uncertain';
              job.code = 'reconciled_after_restart';
            }
          } catch (e) {
            job.status = job.status === 'mutating' ? 'uncertain' : 'failed';
            recordError(job, account, e);
          }
          await save();
          if (m.halted || summary.retryAfterMs) break;
        }
        let consumed = 0;
        for (const account of accounts) {
          const job = p.jobs[account.id];
          if (job.status !== 'pending') continue;
          if (m.halted || summary.retryAfterMs) { job.status = 'blocked'; job.code = 'brack_paused'; continue; }
          try {
            if (!adapter.write && carts[account.id] && Object.keys(carts).length !== 4) {
              // An unavailable account prevents shared quantity planning, not
              // independent read-only verification of the healthy accounts.
              job.status = 'read-only'; summary.cartReadOnly++; continue;
            }
            if (Object.keys(carts).length !== 4) fail('shared_carts_not_verified');
            if (Object.values(p.jobs).some(j => j.status === 'uncertain')) fail('shared_carts_not_verified');
            // Re-read all four carts before each write; use no cached mock positions.
            if (adapter.write) for (const a of accounts) {
              carts[a.id] = await adapter.readCart(a);
              validateCart(carts[a.id], a, now());
            }
            const limits = await adapter.readLimits(account, product);
            validateLimits(limits, product, account, now());
            for (const a of accounts) validateCart(carts[a.id], a, now());
            if (product.source?.provider !== 'brack' || !fresh(product.source.observedAt, now())) fail('product_snapshot_stale');
            const plan = realQuantityPlan({ productId: product.id, accountId: account.id, carts, limits, consumed: adapter.write ? 0 : consumed });
            job.plan = plan; job.before = plan.existingQuantity;
            if (!adapter.write) {
              const after = await adapter.readCart(account);
              validateCart(after, account, now());
              job.after = quantity(after, product.id); job.checkedAt = now().toISOString();
              job.status = 'read-only'; summary.cartReadOnly++;
              consumed += plan.addQuantity;
            } else {
              const before = carts[account.id];
              if (plan.addQuantity > 0) {
                // Durable intent precedes the external side effect; one PUT maximum.
                job.status = 'mutating'; job.attempts = 1;
                job.intent = { before, targetQuantity: plan.targetQuantity };
                await save();
                await adapter.setTarget({ account, product, cart: before, targetQuantity: plan.targetQuantity, limits });
              }
              const after = await adapter.readCart(account);
              validateCart(after, account, now());
              job.after = quantity(after, product.id); job.checkedAt = now().toISOString();
              if (after.cart !== before.cart || !equalItems(after.items, expectedItems(before, product.id, plan.targetQuantity))) fail('cart_verification_failed');
              carts[account.id] = after;
              job.status = 'verified'; summary.cartVerified++;
            }
          } catch (e) {
            const attempted = job.status === 'mutating';
            job.status = attempted ? 'uncertain' : 'blocked';
            recordError(job, account, e);
            if (attempted && !m.halted && !summary.retryAfterMs &&
                !['session_expired', 'account_identity_mismatch'].includes(codeFor(e))) {
              // An ambiguous PUT gets one read-only reconciliation, no second
              // mutation. Restriction/rate-limit responses forbid this extra GET.
              try {
                const actual = await adapter.readCart(account);
                validateCart(actual, account, now());
                job.after = quantity(actual, product.id); job.checkedAt = actual.observedAt;
                if (actual.cart === job.intent.before.cart &&
                    equalItems(actual.items, expectedItems(job.intent.before, product.id, job.intent.targetQuantity))) {
                  job.status = 'verified'; job.code = 'reconciled_after_error';
                  carts[account.id] = actual; summary.cartVerified++;
                }
              } catch (readError) { recordError(job, account, readError); }
            }
          }
          // A save failure after PUT is fatal. Disk keeps 'mutating' for safe recovery.
          await save();
        }
        recordResults(entry, p);
        await save();
      }
      return summary;
    }
  };
}
