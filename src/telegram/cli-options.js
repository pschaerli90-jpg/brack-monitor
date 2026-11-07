export function notificationOptions(args) {
  const options = { mode: 'test', watch: false, intervalMs: 30000, baseline: false };
  const seen = new Set();
  const flags = { '--test': ['mode', 'test'], '--telegram': ['mode', 'telegram'], '--watch': ['watch', true], '--baseline': ['baseline', true] };
  const values = { '--config': 'config', '--fixture': 'fixture', '--interval-seconds': 'interval',
    '--state-dir': 'stateDirectory', '--retry-failed': 'retryFailed', '--ack-uncertain': 'acknowledgeUncertain' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const name = flags[arg]?.[0] ?? values[arg];
    if (!name || seen.has(name)) throw new Error('Unbekannte oder widersprüchliche Benachrichtigungsoption');
    seen.add(name);
    if (flags[arg]) options[name] = flags[arg][1];
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Wert für Benachrichtigungsoption fehlt');
      if (name === 'interval') options.intervalMs = Number(value) * 1000;
      else options[name] = value;
    }
  }
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 30000 || options.intervalMs > 2147483647 ||
      (options.mode === 'telegram' && options.fixture) || (options.mode === 'test' && options.config) ||
      (options.retryFailed && options.acknowledgeUncertain) ||
      (options.baseline && (options.retryFailed || options.acknowledgeUncertain)) ||
      [options.retryFailed, options.acknowledgeUncertain].some(id => id !== undefined && !/^[1-9]\d*$/.test(id))) {
    throw new Error('Ungültige Benachrichtigungsoptionen; echte Zustellung erfordert --telegram ohne Fixture');
  }
  return options;
}
