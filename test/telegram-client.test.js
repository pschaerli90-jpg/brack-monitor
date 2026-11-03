import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TelegramClient, TelegramDeliveryError } from '../src/telegram/client.js';
import { loadTelegramConfig } from '../src/telegram/config.js';
import { discoveryMessage, SimulatedTelegramDelivery } from '../src/telegram/message.js';
import { parseListing } from '../src/brack/parser.js';
import { listing, rawProduct } from './helpers/brack.js';

// Deliberately synthetic, not usable Telegram credentials.
const FAKE_TOKEN = '123456789:' + 'x'.repeat(35);
const FAKE_CHAT = '-1001234567890';
const config = { botToken: FAKE_TOKEN, chatId: FAKE_CHAT };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers }
});
const success = () => response({ ok: true, result: { message_id: 42, chat: { id: Number(FAKE_CHAT) } } });

test('Telegram-Text enthält Produkt, Artikel, Produktsprache, Bestand und direkten Link', () => {
  const p = parseListing(listing()).products[0];
  const text = discoveryMessage(p, { discoveredAt: '2026-11-03T12:00:00.000Z' });
  for (const value of ['Pokémon English Booster', 'Artikelnummer: 100001', 'Sprache: Englisch',
    'Lagerbestand (bei Erkennung): 12', 'https://www.brack.ch/pokemon-english-booster-100001', '2026-11-03T12:00:00.000Z']) assert.ok(text.includes(value));
  assert.match(discoveryMessage({ ...p, stock: null }), /unbekannt/);
  assert.match(discoveryMessage({ ...p, stock: 0 }), /Erkennung\): 0/);
  assert.match(discoveryMessage({ ...p, language: 'de', series: '30-jahre-jubilaeum' }), /Sprache: Deutsch/);
  assert.throws(() => discoveryMessage({ ...p, url: 'https://evil.example' }));
  assert.throws(() => discoveryMessage({ ...p, name: 'x'.repeat(4096) }));
});

test('Lokale Konfiguration akzeptiert vollständige Umgebungswerte, niemals Teilkonfiguration', async () => {
  assert.deepEqual(await loadTelegramConfig({ env: { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: FAKE_CHAT } }), config);
  for (const env of [{}, { TELEGRAM_BOT_TOKEN: FAKE_TOKEN }, { TELEGRAM_CHAT_ID: FAKE_CHAT },
    { TELEGRAM_BOT_TOKEN: FAKE_TOKEN, TELEGRAM_CHAT_ID: 'invalid' }]) {
    await assert.rejects(loadTelegramConfig({ env }), err => !err.message.includes(FAKE_TOKEN) && !err.message.includes(FAKE_CHAT));
  }
  await assert.rejects(loadTelegramConfig({ path: 'anything', env: { TELEGRAM_BOT_TOKEN: FAKE_TOKEN } }), /eine lokale/);
});

test('Konfigurationsdatei muss privat und regulär sein; Fehlermeldungen enthalten keine Werte', async t => {
  const dir = await mkdtemp(fileURLToPath(new URL('../.test-telegram-config-', import.meta.url)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = dir + '/telegram.local.json';
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  assert.deepEqual(await loadTelegramConfig({ path, env: {} }), config);
  await chmod(path, 0o644);
  await assert.rejects(loadTelegramConfig({ path, env: {} }), /0600/);
  await chmod(path, 0o600);
  await symlink(path, dir + '/link');
  await assert.rejects(loadTelegramConfig({ path: dir + '/link', env: {} }), /0600/);
  await writeFile(path, FAKE_TOKEN + FAKE_CHAT);
  await assert.rejects(loadTelegramConfig({ path, env: {} }), err => !err.message.includes(FAKE_TOKEN) && !err.message.includes(FAKE_CHAT));
  await assert.rejects(loadTelegramConfig({ path: dir, env: {} }), /0600/);
});

test('Client sendet genau einen POST an Telegram mit Klartext und erhält nur eine reduzierte Quittung', async () => {
  let calls = 0;
  const client = new TelegramClient(config, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.telegram.org/bot' + FAKE_TOKEN + '/sendMessage');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.ok(options.signal instanceof AbortSignal);
    const payload = JSON.parse(options.body);
    assert.equal(payload.chat_id, FAKE_CHAT);
    assert.equal(payload.text, '<b>plain text</b>');
    assert.equal(payload.parse_mode, undefined);
    assert.deepEqual(payload.link_preview_options, { is_disabled: true });
    return success();
  } });
  assert.deepEqual(await client.send('<b>plain text</b>'), { mode: 'telegram', messageId: 42 });
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(client).includes(FAKE_TOKEN));
  assert.ok(!JSON.stringify(client).includes(FAKE_CHAT));
});

test('429 berücksichtigt Telegram retry_after und HTTP Retry-After ohne internen zweiten POST', async () => {
  let calls = 0;
  const client = new TelegramClient(config, { fetchImpl: async () => {
    calls++; return response({ ok: false, error_code: 429, parameters: { retry_after: 120 } }, 429, { 'retry-after': '180' });
  } });
  await assert.rejects(client.send('message'), err => err instanceof TelegramDeliveryError && err.disposition === 'retry' && err.retryAfterMs === 180000);
  assert.equal(calls, 1);
  for (const retry_after of ['120', Number.MAX_SAFE_INTEGER]) {
    const invalid = new TelegramClient(config, { fetchImpl: async () => response({ ok: false, error_code: 429, parameters: { retry_after } }, 429) });
    await assert.rejects(invalid.send('message'), err => err.disposition === 'permanent');
  }
});

test('Bestätigte 400/401/403-Ablehnungen sind dauerhaft und speichern keine Telegram-Beschreibung', async () => {
  for (const code of [400, 401, 403]) {
    const client = new TelegramClient(config, { fetchImpl: async () => response({ ok: false, error_code: code, description: FAKE_TOKEN + FAKE_CHAT }, code) });
    await assert.rejects(client.send('message'), err => err.disposition === 'permanent' && !JSON.stringify(err).includes(FAKE_TOKEN) && !err.stack.includes(FAKE_CHAT));
  }
});

test('Sicher vor Versand gescheiterte Verbindung ist wiederholbar, Verbindungsabbruch bleibt unklar', async () => {
  for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET']) {
    const client = new TelegramClient(config, { fetchImpl: async () => { throw new TypeError(FAKE_TOKEN + FAKE_CHAT, { cause: { code } }); } });
    await assert.rejects(client.send('message'), err => err.disposition === (code === 'ECONNRESET' ? 'uncertain' : 'retry') && !err.message.includes(FAKE_TOKEN));
  }
  const timeout = new TelegramClient(config, { fetchImpl: async () => { throw new DOMException(FAKE_TOKEN, 'TimeoutError'); } });
  await assert.rejects(timeout.send('message'), err => err.disposition === 'uncertain' && !err.message.includes(FAKE_TOKEN));
});

test('5xx, Redirect, defektes JSON, falscher Empfänger und zu grosse Antworten sind unklar', async () => {
  const factories = [
    () => response({ ok: false, error_code: 500 }, 500),
    () => response({ ok: true, result: { message_id: 42, chat: { id: Number(FAKE_CHAT) } } }, 500),
    () => response({}, 302, { location: 'https://evil.example' }),
    () => new Response(FAKE_TOKEN, { headers: { 'content-type': 'application/json' } }),
    () => new Response('html', { headers: { 'content-type': 'text/html' } }),
    () => response({ ok: true, result: { message_id: 42, chat: { id: 999 } } }),
    () => response({ ok: true, result: { message_id: 0, chat: { id: Number(FAKE_CHAT) } } })
  ];
  for (const factory of factories) {
    let calls = 0;
    const client = new TelegramClient(config, { fetchImpl: async () => { calls++; return factory(); } });
    await assert.rejects(client.send('message'), err => err.disposition === 'uncertain');
    assert.equal(calls, 1);
  }
  const small = new TelegramClient(config, { maxBytes: 2, fetchImpl: async () => success() });
  await assert.rejects(small.send('message'), err => err.disposition === 'uncertain');
});

test('Testzustellung ist ohne Token möglich; ungültige Nachrichten werden vor HTTP abgewiesen', async () => {
  assert.deepEqual(await new SimulatedTelegramDelivery().send('hello'), { mode: 'test', simulated: true });
  let calls = 0;
  const client = new TelegramClient(config, { fetchImpl: async () => { calls++; return success(); } });
  for (const text of ['', ' ', 'x'.repeat(4097), null]) await assert.rejects(client.send(text), err => err.disposition === 'permanent');
  assert.equal(calls, 0);
});
