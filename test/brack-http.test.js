import test from 'node:test';
import assert from 'node:assert/strict';
import { BrackHttp } from '../src/brack/http.js';
import { BRACK_URL } from '../src/brack/parser.js';

const ok = text => new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } });

test('BRACK-Transport verwendet ausschliesslich öffentliche GETs ohne Sitzungsdaten', async () => {
  let calls = 0;
  const http = new BrackHttp({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, BRACK_URL);
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.headers.authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return ok('listing');
  } });
  assert.equal(await http.get(BRACK_URL), 'listing');
  for (const url of ['https://evil.example', 'https://www.brack.ch/cart', BRACK_URL.replace('newdesc', 'stockdesc'), BRACK_URL.replace('www.', 'user@www.')]) {
    await assert.rejects(http.get(url), /erlaubt/);
  }
  assert.equal(calls, 1);
});

test('Netzwerkfehler und 503 werden begrenzt mit Backoff und Retry-After wiederholt', async () => {
  let attempts = 0;
  const waits = [];
  const http = new BrackHttp({ random: () => 0, sleep: async ms => waits.push(ms), fetchImpl: async () => {
    attempts++;
    if (attempts === 1) throw new TypeError('network');
    return attempts === 2 ? new Response('', { status: 503, headers: { 'retry-after': '2' } }) : ok('success');
  } });
  assert.equal(await http.get(BRACK_URL), 'success');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [500, 2000]);
});

test('401, 403 und Redirects werden nie umgangen; lange Retry-After brechen ab', async () => {
  for (const status of [401, 403, 302, 404, 429]) {
    let attempts = 0;
    let waits = 0;
    const http = new BrackHttp({ sleep: async () => { waits++; }, fetchImpl: async () => {
      attempts++; return new Response('', { status, headers: { 'retry-after': '120' } });
    } });
    await assert.rejects(http.get(BRACK_URL));
    assert.equal(attempts, 1);
    assert.equal(waits, 0);
  }
});

test('Timeouts haben ein Versuchslimit; Antworten haben ein Grössen- und Typenlimit', async () => {
  let attempts = 0;
  const http = new BrackHttp({ sleep: async () => {}, fetchImpl: async () => {
    attempts++; throw new DOMException('timeout', 'TimeoutError');
  } });
  await assert.rejects(http.get(BRACK_URL), { name: 'TimeoutError' });
  assert.equal(attempts, 3);
  http.fetchImpl = async () => ok('too big');
  http.maxBytes = 2;
  await assert.rejects(http.get(BRACK_URL), /Grössenlimit/);
  http.fetchImpl = async () => new Response('{}', { headers: { 'content-type': 'application/json' } });
  await assert.rejects(http.get(BRACK_URL), /Inhaltstyp/);
});
