import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { createShareService } from '../share-server.mjs';

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

test('same-network discovery, signaling, and departure', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.join(), ae = await f.events(a);
  assert.deepEqual(await ae.next(), { type: 'peers', data: [] });
  const b = await f.join(), be = await f.events(b);
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
  const b = await f.join(), be = await f.events(b); await be.next(); await ae.next();

  ae.abort.abort();
  assert.deepEqual(await be.next(), { type: 'left', data: { id: a.id } });

  const resumed = await f.events(a);
  assert.equal((await resumed.next()).data[0].id, b.id);
  assert.equal((await be.next()).data.id, a.id);

  await f.post('leave', {}, a);
  assert.deepEqual(await be.next(), { type: 'left', data: { id: a.id, removed: true } });
});

test('room links cross networks, isolate rooms, and never publish tokens', { timeout: 10000 }, async t => {
  const f = await fixture(t, { trustCloudflare: true });
  const room = 'a'.repeat(32), a = await f.join({ room }, { 'CF-Connecting-IP': '192.0.2.1' }), ae = await f.events(a); await ae.next();
  const b = await f.join({ room }, { 'CF-Connecting-IP': '198.51.100.2' }), be = await f.events(b);
  const snapshot = await be.next(); assert.equal(snapshot.data[0].id, a.id); assert.equal(snapshot.data[0].token, undefined);
  const c = await f.join({ room: 'b'.repeat(32) }), ce = await f.events(c);
  assert.deepEqual((await ce.next()).data, []);
  assert.equal((await f.post('signal', { to: c.id, signal: { connection: 'c'.repeat(24), description: { type: 'offer', sdp: 'v=0' } } }, a)).status, 404);
});

test('Cloudflare discovery trusts only explicit proxy configuration', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const a = await f.join({}, { 'CF-Connecting-IP': '192.0.2.1' }), ae = await f.events(a); await ae.next();
  const b = await f.join({}, { 'CF-Connecting-IP': '192.0.2.1' }), be = await f.events(b);
  assert.equal(a.networkKnown, false); assert.deepEqual((await be.next()).data, []);
  const trusted = await fixture(t, { trustCloudflare: true });
  const c = await trusted.join({}, { 'CF-Connecting-IP': '192.0.2.1' }), ce = await trusted.events(c); await ce.next();
  const d = await trusted.join({}, { 'CF-Connecting-IP': '192.0.2.2' }), de = await trusted.events(d);
  assert.equal(c.networkKnown, true); assert.deepEqual((await de.next()).data, []);
  const e = await trusted.join({}, { 'CF-Connecting-IP': '192.0.2.1' }), ee = await trusted.events(e);
  assert.equal((await ee.next()).data[0].id, c.id);
  const missing = await trusted.join(), missingEvents = await trusted.events(missing);
  assert.equal(missing.networkKnown, false); assert.deepEqual((await missingEvents.next()).data, []);
  const missingAgain = await trusted.join(), missingAgainEvents = await trusted.events(missingAgain);
  assert.equal(missingAgain.networkKnown, false); assert.deepEqual((await missingAgainEvents.next()).data, []);
  const malformed = await trusted.join({}, { 'CF-Connecting-IP': 'not-an-ip' });
  assert.equal(malformed.networkKnown, false);
});

test('an untrusted proxy isolates visitors instead of grouping them by its address', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  for (const headers of [{ 'X-Forwarded-For': '192.0.2.1' }, { 'X-Real-IP': '192.0.2.1' }, { Forwarded: 'for=192.0.2.1' }]) {
    const a = await f.join({}, headers), ae = await f.events(a); await ae.next();
    const b = await f.join({}, headers), be = await f.events(b);
    assert.equal(b.networkKnown, false, Object.keys(headers)[0]);
    assert.deepEqual((await be.next()).data, [], Object.keys(headers)[0]);
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

test('limits room size and rate of joining', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 16; i++) await f.join({ room: 'a'.repeat(32) });
  assert.equal((await f.post('join', { room: 'a'.repeat(32) })).status, 429);
  for (let i = 0; i < 13; i++) await f.join({ room: 'b'.repeat(32) });
  assert.equal((await f.post('join', { room: 'c'.repeat(32) })).status, 429);
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
  const a = await f.join(), b = await f.join();
  assert.equal(a.id, first); assert.equal(b.id, unique);
  assert.notEqual(a.name.split(' ').at(-1), b.name.split(' ').at(-1));
  assert.notEqual(a.token, b.token);
  const ae = await f.events(a); assert.deepEqual((await ae.next()).data, []);
  const be = await f.events(b); assert.equal((await be.next()).data[0].id, a.id);
});

test('concurrent joins reserve distinct short codes across separate rooms', async t => {
  let sequence = 0;
  const f = await fixture(t, { random: n => n === 12 ? Buffer.from(Math.floor(sequence++ / 2).toString(16).padStart(24, '0'), 'hex') : randomBytes(n) });
  const joined = await Promise.all(Array.from({ length: 12 }, (_, i) => f.join({ room: i.toString(16).padStart(32, '0') })));
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

test('room creation reserves unused links, retries collisions, and is idempotent', async t => {
  const values = ['a'.repeat(32), 'a'.repeat(32), 'b'.repeat(32)];
  const f = await fixture(t, { random: n => n === 16 ? Buffer.from(values.shift(), 'hex') : randomBytes(n) });
  const a = await f.join(), b = await f.join();
  const [ar, br] = await Promise.all([f.post('room', {}, a), f.post('room', {}, b)]);
  const ac = (await ar.json()).room, bc = (await br.json()).room;
  assert.notEqual(ac, bc); assert.equal(new Set([ac, bc]).size, 2);
  const repeats = await Promise.all([f.post('room', {}, a), f.post('room', {}, a)]);
  for (const response of repeats) assert.equal((await response.json()).room, ac);
  // The allocation remains reserved after its creator leaves without using the link.
  await f.post('leave', {}, a);
  values.push(ac, 'c'.repeat(32));
  const c = await f.join();
  assert.equal((await (await f.post('room', {}, c)).json()).room, 'c'.repeat(32));
  assert.equal((await f.post('room')).status, 401);
});

test('room generation cannot collide with a legacy room or reuse a reserved link on exhaustion', async t => {
  const existing = 'd'.repeat(32), fresh = 'e'.repeat(32);
  const values = [existing, fresh];
  const f = await fixture(t, { random: n => n === 16 ? Buffer.from(values.shift() || fresh, 'hex') : randomBytes(n) });
  const existingPeer = await f.join({ room: existing }), creator = await f.join();
  assert.equal((await (await f.post('room', {}, creator)).json()).room, fresh);
  assert.equal((await f.post('room', {}, existingPeer)).status, 503);
  // Sharing an existing link intentionally still joins the same room.
  const another = await f.join({ room: existing });
  const ae = await f.events(existingPeer); await ae.next();
  const be = await f.events(another); assert.equal((await be.next()).data[0].id, existingPeer.id);
});

test('IPv6 devices on one network share a room; other networks and cellular stay apart', { timeout: 10000 }, async t => {
  const f = await fixture(t, { trustCloudflare: true });
  // Two devices on one Wi-Fi: same /64 prefix, different interface identifiers.
  const laptop = await f.join({}, { 'CF-Connecting-IP': '2600:1700:abcd:1230:1c2d:3e4f:5a6b:7c8d' });
  const laptopEvents = await f.events(laptop); await laptopEvents.next();
  const phone = await f.join({}, { 'CF-Connecting-IP': '2600:1700:abcd:1230:9f8e:7d6c:5b4a:3928' });
  const phoneEvents = await f.events(phone);
  assert.equal(phone.networkKnown, true);
  assert.equal((await phoneEvents.next()).data[0].id, laptop.id);
  // The neighbouring /64 is a different network.
  const neighbour = await f.join({}, { 'CF-Connecting-IP': '2600:1700:abcd:1231:1c2d:3e4f:5a6b:7c8d' });
  const neighbourEvents = await f.events(neighbour);
  assert.deepEqual((await neighbourEvents.next()).data, []);
  // An IPv4-mapped address and its plain form are the same client network.
  const mapped = await f.join({}, { 'CF-Connecting-IP': '::ffff:198.51.100.9' });
  const mappedEvents = await f.events(mapped); await mappedEvents.next();
  const plain = await f.join({}, { 'CF-Connecting-IP': '198.51.100.9' });
  const plainEvents = await f.events(plain);
  assert.equal((await plainEvents.next()).data[0].id, mapped.id);
});
