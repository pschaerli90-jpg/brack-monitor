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
export function endpoint(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      /[?#\\%\s]/.test(path) || /checkout|order|payment|bestell|kasse|logout|delete|remove|clear|add/i.test(path)) fail('contract_path_invalid');
  if (/[{}]/.test(path) || path.split('/').some(p => p === '.' || p === '..')) fail('contract_path_invalid');
  const url = new URL(path, 'https://www.brack.ch');
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
  if ((c.write !== undefined && c.write !== null) || (c.product !== undefined && c.product !== null)) fail('read_only_contract_required');
  for (const [section, fields] of Object.entries({
    identity: ['subject', 'cartId'],
    cart: ['cartId', 'items', 'productId', 'quantity', 'complete']
  })) {
    endpoint(c[section]?.path);
    for (const field of fields) {
      const p = c[section][field];
      if (typeof p !== 'string' || !/^\/(?:[^~]|~[01])+$/.test(p)) fail('contract_pointer_invalid');
    }
  }
  return structuredClone(c);
}
