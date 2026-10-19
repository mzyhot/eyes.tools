import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codecFamily, containerFor, createDownloadService, explain, fileStem, isPublicAddress, planLocal } from '../download-server.mjs';

const FAKE = [process.execPath, new URL('./fake-yt-dlp.mjs', import.meta.url).pathname];

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'eyes-download-test-'));
  const service = createDownloadService({ ytdlp: FAKE, dir, ...options });
  const server = createServer((req, res) => service.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { service.close(); server.closeAllConnections(); server.close(); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/download/`;
  const probe = (body, headers = {}) => fetch(base + 'probe', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const found = async body => { const r = await probe(body); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
  const calls = async () => (await readFile(join(dir, 'calls.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { base, dir, probe, found, calls };
}

test('the browser is told what it can finish itself', () => {
  assert.deepEqual(['avc1.64002A', 'hev1.1.6.L93', 'vp09.00.40.08', 'av01.0.08M.08', 'mp4a.40.2', 'opus', 'none', null, 'xyz'].map(codecFamily),
    ['avc', 'hevc', 'vp9', 'av1', 'aac', 'opus', null, null, 'other']);
  assert.deepEqual(containerFor('avc', 'aac'), { container: 'mp4', ext: 'mp4' });
  assert.deepEqual(containerFor('vp9', 'opus'), { container: 'webm', ext: 'webm' });
  assert.deepEqual(containerFor('vp9', 'aac'), { container: 'mp4', ext: 'mp4' });
  assert.deepEqual(containerFor(null, 'aac'), { container: 'mp4', ext: 'm4a' });
  assert.deepEqual(containerFor(null, 'opus'), { container: 'ogg', ext: 'opus' });
  assert.equal(containerFor('other', 'aac'), null);

  const video = { format_id: 'v', url: 'https://cdn.example/v', ext: 'mp4', container: 'mp4_dash', protocol: 'https', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, filesize: 10 };
  const audio = { format_id: 'a', url: 'https://cdn.example/a', ext: 'm4a', container: 'm4a_dash', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', filesize: 5 };
  assert.deepEqual(planLocal({ requested_formats: [video, audio] }, 'video', 'original'), { process: true, video: true, container: 'mp4', ext: 'mp4', streams: [
    { url: 'https://cdn.example/v', hls: false, direct: true, type: 'video/mp4', size: 10 }, { url: 'https://cdn.example/a', hls: false, direct: true, type: 'audio/mp4', size: 5 }] });
  // What needs a cookie or a referrer comes through the server; an HLS stream only the browser can fetch.
  assert.equal(planLocal({ ...audio, cookies: 'a=1' }, 'audio', 'original').streams[0].direct, false);
  assert.equal(planLocal({ ...audio, http_headers: { 'User-Agent': 'x', Referer: 'https://site.example/' } }, 'audio', 'original').streams[0].direct, false);
  assert.deepEqual(planLocal({ ...audio, protocol: 'm3u8_native', container: undefined }, 'audio', 'original').streams[0], { url: 'https://cdn.example/a', hls: true, direct: true, type: 'audio/mp4', size: 5 });
  assert.equal(planLocal({ ...audio, protocol: 'm3u8_native', http_headers: { Referer: 'https://site.example/' } }, 'audio', 'original'), null);
  // A file already whole goes to the browser's downloads; a DASH one is remade.
  assert.equal(planLocal({ ...audio, container: undefined, ext: 'mp3', acodec: 'mp3' }, 'audio', 'original').process, false);
  assert.equal(planLocal(audio, 'audio', 'original').ext, 'm4a');
  assert.deepEqual(planLocal(audio, 'audio', 'mp3'), { process: true, video: false, container: 'mp3', ext: 'mp3', streams: [{ url: 'https://cdn.example/a', hls: false, direct: true, type: 'audio/mp4', size: 5 }] });
  // Sound from a video drops the picture; a fragmented stream or a huge one is the server's.
  assert.equal(planLocal({ ...video, acodec: 'mp4a.40.2', container: undefined }, 'audio', 'original').ext, 'm4a');
  assert.equal(planLocal({ ...video, protocol: 'http_dash_segments' }, 'video', 'original'), null);
  assert.equal(planLocal({ ...video, filesize: 2 ** 31 }, 'video', 'original'), null);
});

test('the proxy reaches public addresses only', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '100.100.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', '64:ff9b::a00:1', '2002:c0a8:101::1', '2001::1', 'localhost', '']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['1.1.1.1', '142.250.74.46', '2606:4700:4700::1111', '2a00:1450:400f:80d::200e']) assert.equal(isPublicAddress(ip), true, ip);
});

test('errors and names are short and safe', () => {
  assert.equal(explain('WARNING: x\nERROR: [youtube] abc: Private video. Sign in if you have access'), 'this video is private');
  assert.equal(explain('ERROR: Unsupported URL: https://example.com/'), 'this site is not supported');
  assert.equal(explain('ERROR: no suitable extractor found for URL http://192.168.1.1/'), 'this site is not supported');
  assert.equal(explain("ERROR: [youtube] a: Unable to download API page: ('Unable to connect to proxy', OSError('Tunnel connection failed: 403 Forbidden'))"), 'that address cannot be reached from here');
  assert.equal(explain('ERROR: [vimeo] 1: Unable to download webpage: Failed to perform, curl: (7) CONNECT tunnel failed, response 403.'), 'that address cannot be reached from here');
  assert.equal(explain('ERROR: [vimeo] 1: Got HTTP Error 403. If you are using a data center IP or VPN/proxy, your IP may be blocked'), 'the site is refusing the server right now; try again later');
  assert.equal(explain('ERROR: [vimeo] 1: The web client only works when logged-in. Use --cookies, --cookies-from-browser'), 'this video needs an account to watch');
  assert.equal(explain('ERROR: [x] 1: Something odd happened. Please report this issue'), 'something odd happened');
  assert.equal(explain(''), 'the server could not get this video');
  assert.equal(fileStem('a/b: c*d?‮'), 'a b c d');
  assert.equal(fileStem('...'), 'video');
  assert.equal(fileStem(' a title... '), 'a title');
  assert.equal([...fileStem('é'.repeat(300))].length, 120);
});

test('off unless yt-dlp is named, and only for this site and the origins listed', async t => {
  const off = createDownloadService({ ytdlp: '' });
  const server = createServer((req, res) => off.handle(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { off.close(); server.close(); });
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/download/probe`, { method: 'POST' });
  assert.equal(r.status, 503);

  const f = await fixture(t, { allowedOrigins: 'tauri://localhost' });
  assert.equal((await f.probe({ url: 'https://video.example/one' }, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await f.probe({ url: 'https://video.example/one' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const allowed = await f.probe({ url: 'https://video.example/one' }, { Origin: 'tauri://localhost' });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'tauri://localhost');
});

test('two streams are found, passed on untouched, and only a few times', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const job = await f.found({ url: 'https://video.example/two', mode: 'video', quality: '720' });
  assert.match(job.id, /^[a-f0-9]{24}$/);
  assert.equal(job.title, 'A clip: "quoted" / slashed');
  assert.equal(job.filename, 'A clip quoted slashed');
  assert.deepEqual(job.local.streams.map(s => [s.url, s.direct, s.size]), [['https://cdn.example/137.mp4', true, 3000], ['https://cdn.example/140.m4a', true, 1000]]);
  assert.deepEqual([job.local.process, job.local.container, job.local.ext], [true, 'mp4', 'mp4']);
  const lookup = (await f.calls())[0];
  assert.deepEqual(lookup.slice(lookup.indexOf('-f'), lookup.indexOf('-f') + 4), ['-f', 'bv*+ba/b', '-S', 'res:720,+codec:avc:m4a']);
  for (const flag of ['--ignore-config', '--no-playlist', '--use-extractors', '--proxy']) assert.ok(lookup.includes(flag), flag);
  assert.equal(lookup[lookup.indexOf('--use-extractors') + 1], 'default,-generic');

  const video = await fetch(f.base + job.id + '/stream/0?t=' + job.token);
  assert.equal(video.status, 200);
  assert.equal(video.headers.get('content-type'), 'video/mp4');
  assert.deepEqual(Buffer.from(await video.arrayBuffer()), Buffer.alloc(3000, '137'));
  assert.equal((await (await fetch(f.base + job.id + '/stream/1?t=' + job.token)).arrayBuffer()).byteLength, 1000);
  assert.equal((await fetch(f.base + job.id + '/stream/1?t=' + 'f'.repeat(32))).status, 404);
  assert.equal((await fetch(f.base + job.id + '/stream/2?t=' + job.token)).status, 404);
  for (let n = 0; n < 3; n++) await (await fetch(f.base + job.id + '/stream/0?t=' + job.token)).arrayBuffer();
  assert.equal((await fetch(f.base + job.id + '/stream/0?t=' + job.token)).status, 410);

  assert.equal((await fetch(f.base + job.id + '?t=' + job.token, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(f.base + job.id + '?t=' + job.token)).status, 404);
});

test('a whole file is saved under its title; links are checked and refused plainly', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const job = await f.found({ url: 'video.example/one' });
  assert.equal((await f.calls()).at(-1).at(-1), 'https://video.example/one');
  assert.deepEqual([job.local.process, job.local.ext, job.local.streams[0].direct], [false, 'mp4', false]);
  const saved = await fetch(f.base + job.id + '/stream/0?t=' + job.token + '&save=1');
  assert.equal(saved.headers.get('content-length'), '2000');
  assert.equal(saved.headers.get('content-disposition'), `attachment; filename="A clip quoted slashed.mp4"; filename*=UTF-8''A%20clip%20quoted%20slashed.mp4`);
  await saved.arrayBuffer();

  assert.equal((await f.found({ url: 'https://video.example/playlist' })).title, 'first');
  for (const [url, status, error] of [
    ['', 400, 'paste a link to a video'], ['ftp://video.example/one', 400, 'use an http or https link'],
    ['https://user:pass@video.example/one', 400, 'use a link without a name or password in it'],
    ['https://video.example:8443/one', 400, 'that address cannot be reached from here'],
    ['https://video.example/private', 422, 'this video is private'], ['https://nothing.example/', 422, 'this site is not supported'],
    ['https://video.example/long', 422, 'videos over three hours are not supported'], ['https://video.example/live', 422, 'live streams are not supported']
  ]) {
    const r = await f.probe({ url });
    assert.deepEqual([r.status, (await r.json()).error], [status, error], url);
  }
});

test('the server finishes what the browser cannot, and reports progress', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const open = await f.found({ url: 'https://video.example/hls' });
  assert.deepEqual([open.local.process, open.local.streams[0].hls, open.local.streams[0].direct], [true, true, true]);
  // The browser fetches an HLS stream itself; there is nothing for the server to pass on.
  assert.equal((await fetch(f.base + open.id + '/stream/0?t=' + open.token)).status, 404);
  const job = await f.found({ url: 'https://video.example/hls-locked', mode: 'audio', audioFormat: 'mp3' });
  assert.equal(job.local, null);
  assert.equal((await fetch(f.base + job.id + '/file?t=' + job.token)).status, 409);
  const started = await (await fetch(f.base + job.id + '/process?t=' + job.token, { method: 'POST' })).json();
  assert.equal(started.state, 'downloading');
  let state = started;
  while (state.state !== 'ready') {
    assert.notEqual(state.state, 'failed', state.error);
    await new Promise(resolve => setTimeout(resolve, 100));
    state = await (await fetch(f.base + job.id + '?t=' + job.token)).json();
  }
  assert.deepEqual([state.ext, state.size], ['mp3', 'finished mp3'.length]);
  const run = (await f.calls()).at(-1);
  for (const flag of ['-x', '--audio-format', '-P', '--load-info-json']) assert.ok(run.includes(flag), flag);
  const file = await fetch(f.base + job.id + '/file?t=' + job.token);
  assert.equal(file.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await file.text(), 'finished mp3');
});

test('lookups are limited per network, and yt-dlp runs are capped', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const slow = await Promise.all([1, 2, 3, 4].map(() => f.probe({ url: 'https://video.example/slow' })));
  assert.deepEqual(slow.map(r => r.status).sort(), [422, 422, 422, 429]);
  for (let n = 0; n < 26; n++) assert.equal((await f.probe({ url: 'https://nothing.example/' })).status, 422);
  const limited = await f.probe({ url: 'https://video.example/one' });
  assert.equal(limited.status, 429);
  assert.match((await limited.json()).error, /too many links/);
});

test("yt-dlp's requests reach only public addresses, through a proxy only it can use", { timeout: 15000 }, async t => {
  const f = await fixture(t, { resolve: async () => [{ address: '127.0.0.1' }] });
  const proxy = new URL((await f.found({ url: 'https://video.example/proxy' })).title);
  const connect = (target, auth) => new Promise((resolve, reject) => {
    const req = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: target,
      headers: auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64') } : {} });
    req.on('connect', res => { res.socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
  assert.equal(await connect('1.1.1.1:443', false), 407);
  assert.equal(await connect('127.0.0.1:443', true), 403);
  assert.equal(await connect('192.168.1.1:443', true), 403);
  assert.equal(await connect('[::1]:443', true), 403);
  assert.equal(await connect('1.1.1.1:22', true), 403);
  // A name is resolved by the proxy, and refused when it leads somewhere private.
  assert.equal(await connect('public.example:443', true), 403);
});

test('job folders left by an earlier run are cleared at startup', async t => {
  const f = await fixture(t);
  const job = await f.found({ url: 'https://video.example/one' });
  assert.ok((await readdir(f.dir)).includes(job.id));
  const again = createDownloadService({ ytdlp: FAKE, dir: f.dir });
  again.close();
  assert.ok(!(await readdir(f.dir)).includes(job.id));
});
