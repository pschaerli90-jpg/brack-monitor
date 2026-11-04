import { mkdir, lstat, realpath, open, rename, unlink, constants } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { AccountError, REAL_ACCOUNT_IDS, fail } from './account-contract.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
const owned = st => !process.getuid || st.uid === process.getuid();
export class SessionVault {
  #locked = false;
  constructor(directory) {
    if (!isAbsolute(directory ?? '')) fail('vault_absolute_path_required');
    this.directory = resolve(directory);
    const inside = relative(project, this.directory);
    if (!inside.startsWith('..') || inside === '..') fail('vault_must_be_outside_repository');
  }
  async initialise() {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.checkDirectory(this.directory);
      for (const id of REAL_ACCOUNT_IDS) {
        const path = join(this.directory, id);
        await mkdir(path, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
        await this.checkDirectory(path);
      }
    } catch { fail('vault_permissions_invalid'); }
  }
  async checkDirectory(path) {
    const st = await lstat(path);
    if (!st.isDirectory() || !owned(st) || (st.mode & 0o077) || await realpath(path) !== path) fail('vault_permissions_invalid');
  }
  path(name) {
    if (!/^(?:contract|write-approval)\.json$/.test(name) &&
        !/^brack-account-[1-4]\/(?:session|binding)\.json$/.test(name)) fail('vault_path_invalid');
    return join(this.directory, name);
  }
  async read(name, { optional = false } = {}) {
    let h;
    try {
      const path = this.path(name);
      await this.checkDirectory(this.directory);
      if (name.includes('/')) await this.checkDirectory(join(this.directory, name.split('/')[0]));
      h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await h.stat();
      if (!st.isFile() || !owned(st) || (st.mode & 0o077) || st.size > 2_000_000) fail('vault_file_invalid');
      return JSON.parse(await h.readFile('utf8'));
    } catch (e) {
      if (optional && e.code === 'ENOENT') return null;
      fail('vault_file_invalid');
    } finally { await h?.close(); }
  }
  async save(name, value) {
    const path = this.path(name), temporary = path + '.' + randomUUID() + '.tmp';
    await this.checkDirectory(this.directory);
    if (name.includes('/')) await this.checkDirectory(join(this.directory, name.split('/')[0]));
    let h;
    try {
      h = await open(temporary, 'wx', 0o600);
      await h.writeFile(JSON.stringify(value)); await h.sync();
      await h.close(); h = null;
      await rename(temporary, path);
      const d = await open(name.includes('/') ? join(this.directory, name.split('/')[0]) : this.directory, 'r');
      try { await d.sync(); } finally { await d.close(); }
    } catch { fail('vault_save_failed'); }
    finally { await h?.close(); await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async locked(action) {
    await this.initialise();
    let h;
    const path = join(this.directory, 'accounts.lock');
    try { h = await open(path, 'wx', 0o600); }
    catch { throw new AccountError('accounts_locked'); }
    this.#locked = true;
    try { return await action(); }
    finally { this.#locked = false; await h.close(); await unlink(path); }
  }
  assertLocked() { if (!this.#locked) fail('accounts_locked'); }
  async bindings({ complete = true } = {}) {
    const result = {};
    for (const id of REAL_ACCOUNT_IDS) {
      const b = await this.read(id + '/binding.json', { optional: !complete });
      if (!b) continue;
      if (b.version !== 1 || !/^[a-f0-9]{64}$/.test(b.subject) || !/^[a-f0-9]{64}$/.test(b.cart)) fail('binding_invalid');
      result[id] = { subject: b.subject, cart: b.cart };
    }
    if (new Set(Object.values(result).map(b => b.subject)).size !== Object.keys(result).length ||
        new Set(Object.values(result).map(b => b.cart)).size !== Object.keys(result).length) fail('duplicate_brack_accounts');
    return result;
  }
}

export function brackStorageState(value) {
  if (!Array.isArray(value?.cookies) || !Array.isArray(value?.origins)) fail('session_invalid');
  const cookies = value.cookies.filter(c => ['brack.ch', '.brack.ch', 'www.brack.ch', '.www.brack.ch'].includes(c.domain));
  if (!cookies.length || cookies.some(c => c.secure !== true || typeof c.name !== 'string' ||
      typeof c.value !== 'string' || typeof c.path !== 'string')) fail('session_invalid');
  const origins = value.origins.filter(o => o.origin === 'https://www.brack.ch');
  return { cookies, origins };
}
