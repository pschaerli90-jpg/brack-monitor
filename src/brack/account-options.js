import { REAL_ACCOUNT_IDS, fail } from './account-contract.js';

// Manual session enrolment and one-shot cart inspection only. This command
// never starts a scanner, Telegram transport or automatic cart workflow.
export function accountOptions(args) {
  const options = { inspect: false };
  const seen = new Set();
  const values = { '--vault': 'vault', '--login': 'login' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i], key = arg === '--inspect' ? 'inspect' : values[arg];
    if (!key || seen.has(key)) fail('account_options_invalid');
    seen.add(key);
    if (key === 'inspect') options.inspect = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) fail('account_options_invalid');
      options[key] = value;
    }
  }
  if (!options.vault || (options.login && !REAL_ACCOUNT_IDS.includes(options.login)) ||
      (options.login && options.inspect)) fail('account_options_invalid');
  if (!options.login) options.inspect = true;
  return options;
}
