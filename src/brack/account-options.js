import { REAL_ACCOUNT_IDS, fail } from './account-contract.js';
export function accountOptions(args) {
  const options = { watch: false, write: false, telegram: false, baseline: false, intervalMs: 60000 };
  const seen = new Set();
  const flags = { '--watch': 'watch', '--write-approved': 'write', '--telegram': 'telegram', '--baseline': 'baseline', '--inspect': 'inspect' };
  const values = { '--vault': 'vault', '--login': 'login', '--interval-seconds': 'interval', '--config': 'config' };
  for (let i = 0; i < args.length; i++) {
    const key = flags[args[i]] ?? values[args[i]];
    if (!key || seen.has(key)) fail('account_options_invalid');
    seen.add(key);
    if (flags[args[i]]) options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('account_options_invalid');
      if (key === 'interval') options.intervalMs = Number(value) * 1000;
      else options[key] = value;
    }
  }
  if (!options.vault || !Number.isSafeInteger(options.intervalMs) || options.intervalMs < 30000 || options.intervalMs > 2147483647 ||
      (options.login && !REAL_ACCOUNT_IDS.includes(options.login)) || (options.config && !options.telegram) ||
      ((options.login || options.inspect) && (options.watch || options.write || options.telegram || options.baseline)) ||
      (options.login && options.inspect)) fail('account_options_invalid');
  return options;
}
