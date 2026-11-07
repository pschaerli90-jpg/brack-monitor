import { mkdir, open, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from '../store.js';
import { fail } from './account-contract.js';

// Reuse the existing durable Store/lock, with an explicit private external root.
export class AccountStore extends Store {
  constructor(vault, mode) {
    if (!['read-test', 'write'].includes(mode)) fail('account_options_invalid');
    super(join(vault.directory, mode + '-state'), { rootDirectory: vault.directory });
    this.vault = vault;
  }
  async locked(action) {
    await mkdir(this.directory, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    await this.vault.checkDirectory(this.directory);
    return super.locked(action);
  }
  async load() {
    let h;
    try {
      h = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = await h.stat();
      if (!st.isFile() || st.size > 10_000_000 || st.mode & 0o077 ||
          (process.getuid && st.uid !== process.getuid())) fail('account_state_permissions_invalid');
    } catch (e) { if (e.code !== 'ENOENT') fail('account_state_permissions_invalid'); }
    finally { await h?.close(); }
    return super.load();
  }
}
