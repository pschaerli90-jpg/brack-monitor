import test from 'node:test';
import assert from 'node:assert/strict';
import { runLoop } from '../src/runner.js';
import { runDiscoveryMonitor } from '../src/telegram/outbox.js';
import { BrackScanner } from '../src/brack/scanner.js';
import { BrackHttp } from '../src/brack/http.js';
import { Store } from '../src/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { listing } from './helpers/brack.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('Runner lehnt Intervalle unter 30 Sekunden vor dem ersten Scan ab', async () => {
  for (const intervalMs of [0, -1, 29999, NaN, 30000.5]) {
    await assert.rejects(runLoop({ intervalMs, run: () => assert.fail('Kein Scan') }), /30 Sekunden/);
  }
});

test('30 Sekunden Pause erst nach vollständigem Scan und sofortiger Meldungsverarbeitung', async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('../.test-runner-', import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  let release, entered;
  const sending = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const abort = new AbortController();
  let scans = 0;
  const scanner = new BrackScanner({ http: { get: async () => {
    events.push('scan'); scans++; return listing();
  } } });
  const running = runLoop({ watch: true, intervalMs: 30000, signal: abort.signal,
    run: () => runDiscoveryMonitor({ scanner, store: new Store(directory), source: 'fixture', log: () => {},
      telegram: { mode: 'test', send: async () => {
        events.push('send'); entered(); await held;
        events.push('sent'); return { mode: 'test', simulated: true };
      } } }),
    sleep: async ms => {
      assert.equal(ms, 30000);
      events.push('sleep');
      assert.deepEqual(events, scans === 1 ? ['scan', 'send', 'sent', 'sleep'] :
        ['scan', 'send', 'sent', 'sleep', 'scan', 'sleep']);
      if (scans === 2) abort.abort();
    } });
  try {
    await sending;
    assert.deepEqual(events, ['scan', 'send']);
    assert.equal(scans, 1);
  } finally { release(); }
  await running;
  assert.equal(scans, 2);
});

test('30-Sekunden-Telegram-Lauf respektiert BRACK-429 und stoppt bei CAPTCHA oder 403', async t => {
  for (const kind of ['429', 'captcha', '403']) {
    const directory = await mkdtemp(fileURLToPath(new URL('../.test-protection-', import.meta.url)));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const abort = new AbortController();
    let requests = 0, sleeps = 0;
    const http = new BrackHttp({ fetchImpl: async () => {
      requests++;
      return kind === 'captcha' ?
        new Response('<title>CAPTCHA</title>', { headers: { 'content-type': 'text/html' } }) :
        new Response('', { status: Number(kind), headers: { 'retry-after': '120' } });
    }, sleep: () => assert.fail('Kein sofortiger Retry') });
    const result = await runLoop({ watch: true, intervalMs: 30000, signal: abort.signal,
      run: () => runDiscoveryMonitor({ scanner: new BrackScanner({ http }), store: new Store(directory),
        telegram: { mode: 'test', send: () => assert.fail('Keine Meldung') }, log: () => {} }),
      sleep: async ms => { sleeps++; assert.equal(ms, 120000); abort.abort(); } });
    assert.equal(requests, 1);
    assert.equal(sleeps, kind === '429' ? 1 : 0);
    assert.equal(result.halted === true, kind !== '429');
  }
});

test('Bestehende Lesescanner-CLI behält die Mindestgrenze von 60 Sekunden', async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(promisify(execFile)(process.execPath,
    ['src/read-only-cli.js', '--interval-seconds', '30'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), timeout: 10000, env }),
  err => err.code === 1);
});
