import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { notificationOptions } from '../src/telegram/cli-options.js';
import { listing } from './helpers/brack.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('Neue CLI ist standardmässig simuliert und akzeptiert nur ausdrückliche echte Zustellung', () => {
  assert.equal(notificationOptions([]).mode, 'test');
  assert.equal(notificationOptions([]).intervalMs, 60000);
  assert.equal(notificationOptions(['--telegram', '--watch', '--interval-seconds', '30']).intervalMs, 30000);
  for (const seconds of ['0', '-1', '29', '29.999', 'NaN']) {
    assert.throws(() => notificationOptions(['--interval-seconds', seconds]));
  }
  assert.equal(notificationOptions(['--telegram']).mode, 'telegram');
  const options = notificationOptions(['--test', '--fixture', 'fixture.html', '--watch', '--interval-seconds', '120', '--baseline']);
  assert.equal(options.mode, 'test');
  assert.equal(options.intervalMs, 120000);
  assert.equal(options.baseline, true);
  for (const args of [['--telegram', '--fixture', 'fixture.html'], ['--config', 'file.json'], ['--telegram', '--test'],
    ['--watch', '--watch'], ['--interval-seconds', '1'], ['--interval-seconds', '999999999999'],
    ['--token', 'anything'], ['--chat-id', 'anything'], ['--config'],
    ['--baseline', '--retry-failed', '100001'], ['--retry-failed', '100001', '--ack-uncertain', '100001'], ['--retry-failed', 'x']]) {
    assert.throws(() => notificationOptions(args));
  }
});

test('Komplette Fixture-CLI simuliert einmal, übersteht Neustart und liest keinerlei Telegram-Konfiguration', async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('../.test-telegram-cli-', import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = directory + '/listing.html';
  await writeFile(fixture, listing());
  const stateDir = directory + '/state';
  const args = ['src/telegram-cli.js', '--fixture', fixture, '--state-dir', stateDir, '--interval-seconds', '30'];
  const env = { ...process.env, BRACK_TELEGRAM_CONFIG: directory + '/does-not-exist',
    TELEGRAM_BOT_TOKEN: 'must-not-be-read', TELEGRAM_CHAT_ID: 'must-not-be-logged' };
  delete env.NODE_TEST_CONTEXT; // The CLI is a normal process, not another test-runner child.
  const first = await execute(process.execPath, args, { cwd: root, env, timeout: 10000 });
  const initial = JSON.parse(await readFile(stateDir + '/state.json', 'utf8')).discovery.entries['100001'];
  assert.deepEqual(initial.receipt, { mode: 'test', simulated: true });
  assert.equal(initial.attempts, 1);
  const second = await execute(process.execPath, args, { cwd: root, env, timeout: 10000 });
  const state = JSON.parse(await readFile(stateDir + '/state.json', 'utf8'));
  assert.deepEqual(state.discovery.entries['100001'], initial);
  assert.equal(state.discovery.entries['100001'].status, 'sent');
  assert.equal(state.discovery.mode, 'test');
  for (const output of [first.stdout + first.stderr, second.stdout + second.stderr, JSON.stringify(state)]) {
    assert.ok(!output.includes(env.TELEGRAM_BOT_TOKEN)); assert.ok(!output.includes(env.TELEGRAM_CHAT_ID));
  }
});

test('Echter CLI-Modus ohne sichere Konfiguration scheitert vor Scan, POST und Zustandserstellung', async t => {
  const directory = await mkdtemp(fileURLToPath(new URL('../.test-telegram-cli-', import.meta.url)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const key of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'BRACK_TELEGRAM_CONFIG']) delete env[key];
  await assert.rejects(execute(process.execPath, ['src/telegram-cli.js', '--telegram', '--state-dir', directory + '/state'],
    { cwd: root, env, timeout: 10000 }), err => err.code === 1);
  await assert.rejects(readFile(directory + '/state/state.json'), { code: 'ENOENT' });
});
