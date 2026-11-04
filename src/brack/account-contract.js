import { createHash } from 'node:crypto';

export const REAL_ACCOUNT_IDS = Object.freeze(Array.from({ length: 4 }, (_, i) => 'brack-account-' + (i + 1)));
export const integer = n => Number.isSafeInteger(n) && n >= 0;
export const hash = value => createHash('sha256').update(value).digest('hex');
export class AccountError extends Error {
  constructor(code, { halt = false, retryAfterMs = 0 } = {}) {
    super(code); this.name = 'AccountError'; this.code = code;
    this.halt = halt; this.retryAfterMs = retryAfterMs;
  }
}
export const fail = code => { throw new AccountError(code); };
export function validateRealAccounts(accounts) {
  if (!Array.isArray(accounts) || accounts.length !== 4 ||
      accounts.some((a, i) => a?.id !== REAL_ACCOUNT_IDS[i] || a.mode !== 'brack-real')) fail('four_accounts_required');
}
export const realAccounts = () => REAL_ACCOUNT_IDS.map(id => Object.freeze({ id, mode: 'brack-real' }));

// Contract paths must be observed on BRACK, never guessed. No arbitrary origins,
// redirects, executable parsers, checkout or order operations are configurable.
export function endpoint(path, productId) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      /[?#\\%\s]/.test(path) || /checkout|order|payment|bestell|kasse|logout|delete|remove|clear|add/i.test(path)) fail('contract_path_invalid');
  if (productId !== undefined && !/^[1-9]\d*$/.test(productId)) fail('product_id_invalid');
  const value = path.replaceAll('{productId}', productId ?? '1');
  if (/[{}]/.test(value) || value.split('/').some(p => p === '.' || p === '..')) fail('contract_path_invalid');
  const url = new URL(value, 'https://www.brack.ch');
  if (url.origin !== 'https://www.brack.ch') fail('contract_path_invalid');
  return url.href;
}
export function pointer(value, path) {
  if (typeof path !== 'string' || !path.startsWith('/')) fail('contract_pointer_invalid');
  for (const key of path.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!value || !Object.hasOwn(value, key)) fail('brack_schema_unknown');
    value = value[key];
  }
  return value;
}
export function validateContract(c) {
  if (c?.version !== 1 || c.origin !== 'https://www.brack.ch' ||
      typeof c.reviewedAt !== 'string' || !Number.isFinite(Date.parse(c.reviewedAt)) ||
      c.reviewed !== true) fail('contract_not_reviewed');
  for (const [section, fields] of Object.entries({
    identity: ['subject', 'cartId'],
    cart: ['cartId', 'items', 'productId', 'quantity', 'complete'],
    product: ['productId', 'stock', 'maxPerOrder', 'accountLimit', 'globalLimit', 'limitsComplete']
  })) {
    if (section === 'product' && c.product === null) continue;
    endpoint(c[section]?.path);
    if (section === 'product' && !c[section].path.includes('{productId}')) fail('contract_path_invalid');
    for (const field of fields) {
      const p = c[section][field];
      if (typeof p !== 'string' || !/^\/(?:[^~]|~[01])+$/.test(p)) fail('contract_pointer_invalid');
    }
  }
  if (c.product !== null && c.limitSemantics !== 'total-including-all-four-carts') fail('limit_semantics_unverified');
  if (c.write !== null) {
    if (!c.product) fail('limits_unknown');
    const w = c.write;
    endpoint(w?.path);
    if (!w.path.includes('{productId}') || w.method !== 'PUT' || w.semantics !== 'set-total' ||
        w.precondition !== 'If-Match' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(w.quantityField) ||
        !/^[A-Za-z][A-Za-z0-9_-]*$/.test(w.csrfCookie) ||
        !/^X-[A-Za-z0-9-]+$/i.test(w.csrfHeader)) fail('write_contract_invalid');
  }
  return structuredClone(c);
}

// A local, expiring grant is intentionally separate from CLI options/config.
// Creating this file requires a later, explicit operator approval.
export function validateGrant(grant, contract, bindings, now = new Date()) {
  if (!contract.write || !contract.product || grant?.version !== 1 || grant.approved !== true ||
      grant.operation !== 'fill-carts-only' || grant.contractSha256 !== hash(JSON.stringify(contract)) ||
      !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now.getTime() ||
      Date.parse(grant.expiresAt) - now.getTime() > 86400000 ||
      JSON.stringify(grant.bindings) !== JSON.stringify(bindings)) fail('cart_writes_not_approved');
}
