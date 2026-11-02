import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
export class Store {
  constructor(directory) {
    this.directory = resolve(directory);
    if (!this.directory.startsWith(root)) throw new Error('Zustand muss innerhalb brack-monitor liegen');
    this.path = join(this.directory, 'state.json');
  }
  async locked(action) {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, 'run.lock');
    const handle = await open(path, 'wx', 0o600);
    try { return await action(); }
    finally { await handle.close(); await unlink(path); }
  }
  async load() {
    let raw;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (err) { if (err.code === 'ENOENT') return { version: 1, products: {} }; throw err; }
    const state = JSON.parse(raw);
    if (state?.version !== 1 || !state.products || typeof state.products !== 'object' || Array.isArray(state.products)) {
      throw new Error('Ungültiger Zustand; kein automatisches Zurücksetzen');
    }
    for (const entry of Object.values(state.products)) {
      if (!entry || !['pending', 'prepared', 'done'].includes(entry.status) || !entry.product ||
          typeof entry.key !== 'string' || !Number.isSafeInteger(entry.attempts) || entry.attempts < 0) {
        throw new Error('Ungültiger Produkteintrag');
      }
    }
    return state;
  }
  async save(state) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, this.path);
  }
}
