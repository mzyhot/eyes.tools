import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { createShareService, networkOf } from '../share-server.mjs';

async function fixture(t, options = {}) {
  const share = createShareService(options);
  const server = createServer((req, res) => share.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { share.close(); server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}, session, headers = {}) => fetch(base + '/api/share/' + path + (session ? '?id=' + session.id : ''), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: 'Bearer ' + session.token } : {}), ...headers }, body: JSON.stringify(body)
  });
  const join = async (body = {}, headers = {}) => { const r = await post('join', body, null, headers); assert.equal(r.status, 200); return r.json(); };
  const events = async (session, headers = {}) => {
    const abort = new AbortController(); t.after(() => abort.abort());
    const response = await fetch(base + '/api/share/events?id=' + session.id, { headers: { Authorization: 'Bearer ' + session.token, ...headers }, signal: abort.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
    return { abort, async next() {
      while (!text.includes('\n\n')) { const chunk = await reader.read(); if (chunk.done) throw new Error('stream ended'); text += decoder.decode(chunk.value); }
      const end = text.indexOf('\n\n'), event = text.slice(0, end); text = text.slice(end + 2);
      return { type: event.match(/^event: (.+)$/m)[1], data: JSON.parse(event.match(/^data: (.+)$/m)[1]) };
    } };
  };
  return { base, post, join, events };
}

test('a link introduces two devices, relays their signals, and reports a departure', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.join(), ae = await f.events(a);
  assert.equal(a.room, a.id, 'a join without a link is given its own id as one');
  assert.deepEqual(await ae.next(), { type: 'peers', data: [] });
  const b = await f.join({ room: a.room }), be = await f.events(b);
  assert.equal((await be.next()).data[0].id, a.id);
  assert.equal((await ae.next()).data.id, b.id);
  const signal = { connection: 'a'.repeat(24), description: { type: 'offer', sdp: 'v=0\r\n' } };
  assert.equal((await f.post('signal', { to: b.id, signal }, a)).status, 200);
  assert.deepEqual(await be.next(), { type: 'signal', data: { from: a.id, signal } });
  await f.post('leave', {}, a);
  assert.deepEqual(await be.next(), { type: 'left', data: { id: a.id, removed: true } });
});

test('stream loss is temporary but session removal is final', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.join(), ae = await f.events(a); await ae.next();
  const b = await f.join({ room: a.room }), be = await f.events(b); await be.next(); await ae.next();

  ae.abort.abort();
  assert.deepEqual(await be.next(), { type: 'left', data: { id: a.id } });

  const resumed = await f.events(a);
  assert.equal((await resumed.next()).data[0].id, b.id);
  assert.equal((await be.next()).data.id, a.id);

  await f.post('leave', {}, a);
  assert.deepEqual(await be.next(), { type: 'left', data: { id: a.id, removed: true } });
});

test('a link crosses networks, isolates other rooms, and never publishes tokens', { timeout: 10000 }, async t => {
  const f = await fixture(t, { trustCloudflare: true });
  const room = 'a'.repeat(24), a = await f.join({ room }, { 'CF-Connecting-IP': '192.0.2.1' }), ae = await f.events(a); await ae.next();
  const b = await f.join({ room }, { 'CF-Connecting-IP': '198.51.100.2' }), be = await f.events(b);
  const snapshot = await be.next(); assert.equal(snapshot.data[0].id, a.id); assert.equal(snapshot.data[0].token, undefined);
  const c = await f.join({ room: 'b'.repeat(24) }), ce = await f.events(c);
  assert.deepEqual((await ce.next()).data, []);
  assert.equal((await f.post('signal', { to: c.id, signal: { connection: 'c'.repeat(24), description: { type: 'offer', sdp: 'v=0' } } }, a)).status, 404);
});

test('without a link a session is alone, and its link dies with it', { timeout: 10000 }, async t => {
  const f = await fixture(t, { trustCloudflare: true });
  const headers = { 'CF-Connecting-IP': '192.0.2.1' };
  // Two tabs on one network, and one address: still two rooms, never one.
  const a = await f.join({}, headers), ae = await f.events(a); await ae.next();
  const b = await f.join({}, headers), be = await f.events(b);
  assert.notEqual(a.room, b.room);
  assert.deepEqual((await be.next()).data, []);

  // The link reaches its session, and nobody once that session has gone.
  const guest = await f.join({ room: a.room }), ge = await f.events(guest);
  assert.equal((await ge.next()).data[0].id, a.id);
  await f.post('leave', {}, a); await f.post('leave', {}, guest);
  const late = await f.join({ room: a.room }), le = await f.events(late);
  assert.deepEqual((await le.next()).data, []);
});

test('behind a trusted proxy the join limit follows the visitor, not the proxy', async t => {
  const f = await fixture(t, { trustCloudflare: true });
  const visitor = { 'CF-Connecting-IP': '192.0.2.1' };
  for (let i = 0; i < 30; i++) assert.equal((await f.post('join', {}, null, visitor)).status, 200, 'join ' + i);
  assert.equal((await f.post('join', {}, null, visitor)).status, 429);
  assert.equal((await f.post('join', {}, null, { 'CF-Connecting-IP': '192.0.2.2' })).status, 200);
  // A malformed or absent header falls back to the socket address, never to trust.
  assert.equal((await f.post('join', {}, null, { 'CF-Connecting-IP': 'not-an-ip' })).status, 200);
});

test('an untrusted proxy header cannot move a visitor off their own limit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) {
    assert.equal((await f.post('join', {}, null, { 'X-Forwarded-For': '192.0.2.' + i })).status, 200, 'join ' + i);
  }
  for (const headers of [{ 'X-Forwarded-For': '203.0.113.9' }, { 'X-Real-IP': '203.0.113.9' }, { Forwarded: 'for=203.0.113.9' }, {}]) {
    assert.equal((await f.post('join', {}, null, headers)).status, 429, Object.keys(headers)[0] || 'no header');
  }
});

test('rejects cross-origin requests, invalid credentials and malformed payloads', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('join', {}, null, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await f.post('join', {}, null, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await f.post('join', { room: 'guessable' })).status, 400);
  assert.equal((await f.post('join', { room: 'x'.repeat(70000) })).status, 400);
  const a = await f.join();
  assert.equal((await f.post('leave', {}, { ...a, token: '0'.repeat(64) })).status, 401);
  assert.equal((await fetch(f.base + '/api/share/events?id=' + a.id)).status, 401);
});

test('only origins the operator lists may use the service cross-origin, with CORS', async t => {
  const f = await fixture(t, { allowedOrigins: 'tauri://localhost, http://tauri.localhost' });
  const app = { Origin: 'tauri://localhost', 'Sec-Fetch-Site': 'cross-site' };

  const preflight = await fetch(f.base + '/api/share/join', { method: 'OPTIONS', headers: { ...app, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'tauri://localhost');
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);

  const joined = await f.post('join', {}, null, app);
  assert.equal(joined.status, 200);
  assert.equal(joined.headers.get('access-control-allow-origin'), 'tauri://localhost');
  assert.equal(joined.headers.get('vary'), 'Origin');
  const a = await joined.json();
  const b = await f.join({ room: a.room }, { Origin: 'http://tauri.localhost', 'Sec-Fetch-Site': 'cross-site' });
  const b1 = await f.events(b, { Origin: 'http://tauri.localhost' });
  assert.deepEqual((await b1.next()).data, []);
  const a1 = await f.events(a, app);
  assert.equal((await a1.next()).data[0].id, b.id);

  // Same-origin pages keep working and get no CORS headers; anyone else is refused.
  const site = await f.post('join');
  assert.equal(site.status, 200);
  assert.equal(site.headers.get('access-control-allow-origin'), null);
  for (const Origin of ['https://unrelated.example', 'tauri://localhost.example', 'null']) {
    const refused = await f.post('join', {}, null, { Origin, 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(refused.status, 403);
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await fetch(f.base + '/api/share/join', { method: 'OPTIONS', headers: { Origin: 'https://unrelated.example' } })).status, 403);
});

test('no origin is allowed cross-origin unless listed', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('join', {}, null, { Origin: 'tauri://localhost', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
});

test('limits room size and rate of joining', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 16; i++) await f.join({ room: 'a'.repeat(24) });
  const full = await f.post('join', { room: 'a'.repeat(24) });
  assert.equal(full.status, 429);
  assert.match((await full.json()).error, /room is full/);
  /* The refused join still counts: 17 made, 13 more reach the limit of 30 a
     minute, and the next is refused. */
  for (let i = 0; i < 13; i++) await f.join({ room: 'b'.repeat(24) });
  const limited = await f.post('join', { room: 'c'.repeat(24) });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /too many joins/);
});

test('TURN uses expiring credentials without exposing its shared secret', async t => {
  const f = await fixture(t, { turnSecret: 'test-only-secret', turnUrls: 'turn:relay.example:3478,turns:relay.example:5349', now: () => 1000000 });
  const a = await f.join(), turn = a.iceServers[1];
  assert.equal(turn.username, `4600:${a.id}`);
  assert.equal(turn.credential, createHmac('sha1', 'test-only-secret').update(turn.username).digest('base64'));
  assert.equal(JSON.stringify(a).includes('test-only-secret'), false);
});


test('retries duplicate IDs, visible short codes, and authentication tokens without replacing peers', async t => {
  const first = '00'.repeat(10) + '1111', sameCode = '22'.repeat(10) + '1111', unique = '33'.repeat(10) + '2222';
  const ids = [first, first, sameCode, unique];
  const tokens = ['aa'.repeat(32), 'aa'.repeat(32), 'bb'.repeat(32)];
  const f = await fixture(t, { random: n => Buffer.from((n === 12 ? ids : tokens).shift(), 'hex') });
  const a = await f.join(), b = await f.join({ room: a.room });
  assert.equal(a.id, first); assert.equal(b.id, unique);
  assert.notEqual(a.name.split(' ').at(-1), b.name.split(' ').at(-1));
  assert.notEqual(a.token, b.token);
  const ae = await f.events(a); assert.deepEqual((await ae.next()).data, []);
  const be = await f.events(b); assert.equal((await be.next()).data[0].id, a.id);
});

test('concurrent joins reserve distinct short codes across separate rooms', async t => {
  let sequence = 0;
  const f = await fixture(t, { random: n => n === 12 ? Buffer.from(Math.floor(sequence++ / 2).toString(16).padStart(24, '0'), 'hex') : randomBytes(n) });
  const joined = await Promise.all(Array.from({ length: 12 }, (_, i) => f.join({ room: i.toString(16).padStart(24, '0') })));
  assert.equal(new Set(joined.map(s => s.id.slice(-4))).size, joined.length);
  assert.equal(new Set(joined.map(s => s.name)).size, joined.length);
});

test('broken randomness fails closed instead of overwriting a session', async t => {
  const f = await fixture(t, { random: n => Buffer.alloc(n, 7) });
  const a = await f.join();
  const failed = await f.post('join');
  assert.equal(failed.status, 503); assert.match((await failed.json()).error, /unique code/);
  assert.equal((await f.post('leave', {}, a)).status, 200);
});

test('the join limit counts a network, not one address in it', async t => {
  // Two devices on one Wi-Fi share a /64; the neighbouring one is another
  // network, and an IPv4-mapped address is the same client as its plain form.
  assert.equal(networkOf('2600:1700:abcd:1230:1c2d:3e4f:5a6b:7c8d'), networkOf('2600:1700:abcd:1230:9f8e:7d6c:5b4a:3928'));
  assert.notEqual(networkOf('2600:1700:abcd:1230::1'), networkOf('2600:1700:abcd:1231::1'));
  assert.equal(networkOf('::ffff:198.51.100.9'), networkOf('198.51.100.9'));
  assert.equal(networkOf('2600:1700:abcd:1230::1'), '2600:1700:abcd:1230::/64');
});
