// Run with a local server: SHARE_TEST_URL=http://127.0.0.1:8877 node tests/share-browser.mjs
// Install Playwright for development, or set PLAYWRIGHT_MODULE to its module path.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, randomFillSync } from 'node:crypto';
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createEyesServer } from '../dev-server.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const base = process.env.SHARE_TEST_URL || 'http://127.0.0.1:8877';
const output = process.env.SHARE_TEST_OUTPUT || '/tmp/eyes-share-tests';
await mkdir(output, { recursive: true });
const errors = [], requests = [];
/* Every page opens a room of its own; a second device joins by opening the
   first one's link. Devices on one network also find each other, but only
   when the service knows the network, never from loopback, which is all
   this suite connects from, so here every meeting is by link except the
   tests that set a trusted visitor address.
   Chromium saves received files to its downloads as they arrive. A page
   with `noDownloads` cannot, as Safari cannot, and keeps them in its storage,
   or with `noStorage` too, in memory. */
async function page({ holdPeerConnectionOpen = false, link = '', noStorage = false, noDownloads = false, address = '' } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, ...(address ? { extraHTTPHeaders: { 'CF-Connecting-IP': address } } : {}) });
  /* A browser without the private file system, as a private window may be. */
  if (noStorage) await context.addInitScript(() => { if (globalThis.StorageManager) delete StorageManager.prototype.getDirectory; });
  if (noDownloads) await context.addInitScript(() => { delete Navigator.prototype.serviceWorker; });
  if (holdPeerConnectionOpen) await context.addInitScript(() => {
    /* Model a deliberate departure whose remote data channel remains open.
       This is the ordering that made a permanent leave look temporary. */
    globalThis.__holdPeerConnectionOpenForTest = false;
    const closeChannel = RTCDataChannel.prototype.close;
    const closeConnection = RTCPeerConnection.prototype.close;
    RTCDataChannel.prototype.close = function (...args) {
      if (!globalThis.__holdPeerConnectionOpenForTest) return closeChannel.apply(this, args);
    };
    RTCPeerConnection.prototype.close = function (...args) {
      if (!globalThis.__holdPeerConnectionOpenForTest) return closeConnection.apply(this, args);
    };
  });
  const p = await context.newPage();
  p.on('pageerror', e => errors.push(e.message));
  p.on('request', r => { if (r.url().includes('/api/share/')) requests.push({ url: r.url(), bytes: Buffer.byteLength(r.postData() || '') }); });
  await p.goto(link || base + '/share');
  return p;
}
async function connected(p, count = 1) {
  await p.waitForFunction(n => document.querySelectorAll('.device__action').length === n && [...document.querySelectorAll('.device__action')].every(e => e.textContent === 'ready'), count, { timeout: 40000 });
}
async function choose(p, files, to = /^send files to /) {
  const chooser = p.waitForEvent('filechooser'); await p.getByRole('button', { name: to }).first().click(); await (await chooser).setFiles(files);
}
/** What this page's origin holds in the private file system. A folder or
    file removed while it is being listed is skipped, not an error. */
const stored = p => p.evaluate(async () => {
  const share = await (await navigator.storage.getDirectory()).getDirectoryHandle('share', { create: true });
  const folders = [];
  let bytes = 0;
  for await (const [name, folder] of share.entries()) {
    folders.push(name);
    try { for await (const file of folder.values()) bytes += (await file.getFile()).size; }
    catch (error) { if (error.name !== 'NotFoundError') throw error; }
  }
  return { folders, bytes };
});
/** Poll until `test` accepts what is stored. */
async function storedUntil(p, test) {
  for (let i = 0; i < 100; i++) { if (test(await stored(p))) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error('storage never reached the expected state');
}
const digest = b => createHash('sha256').update(b).digest('hex');
/** The room link a page is handing out, once the service has minted it. */
async function roomLink(p) {
  await p.locator('#room-panel').waitFor();
  const link = await p.locator('#room-link').inputValue();
  assert.match(link, /#room=[a-f0-9]{24}$/, 'a link to pass on');
  return link;
}
async function cuttableProxy(target) {
  const upstream = new URL(target), sockets = new Set(); let cut = false;
  const server = createTcpServer(client => {
    if (cut) { client.destroy(); return; }
    const up = tcpConnect(Number(upstream.port), upstream.hostname);
    for (const socket of [client, up]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); }
    client.pipe(up); up.pipe(client);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    base: 'http://127.0.0.1:' + server.address().port,
    cut() { cut = true; for (const socket of sockets) socket.destroy(); },
    restore() { cut = false; },
    close() { for (const socket of sockets) socket.destroy(); server.close(); }
  };
}
/** A proxy that holds every response back until it ends, headers and all,
    as some company proxies and antivirus web shields do. */
async function bufferingProxy(target) {
  const upstream = new URL(target);
  const server = createHttpServer((req, res) => {
    const forward = httpRequest({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers }, reply => {
      const chunks = [];
      reply.on('data', chunk => chunks.push(chunk));
      reply.on('end', () => { res.writeHead(reply.statusCode, reply.headers); res.end(Buffer.concat(chunks)); });
    });
    forward.on('error', () => res.destroy());
    res.on('close', () => forward.destroy());
    req.pipe(forward);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { base: 'http://127.0.0.1:' + server.address().port, close() { server.closeAllConnections(); server.close(); } };
}
async function download(p, name, expected) {
  const ready = p.waitForEvent('download'); await p.getByRole('link', { name: 'download ' + name, exact: true }).click();
  const file = await ready; assert.equal(file.suggestedFilename(), name);
  assert.equal(digest(await readFile(await file.path())), digest(expected));
}
/** The next `count` downloads a page begins. */
function downloads(p, count) {
  const begun = [];
  return new Promise(resolve => {
    const add = file => { begun.push(file); if (begun.length === count) { p.off('download', add); resolve(begun); } };
    p.on('download', add);
  });
}
/** Accept the offer on `p` and check every file it saves, by name, against `expected`. */
async function accept(p, expected) {
  const begun = downloads(p, Object.keys(expected).length);
  await p.getByRole('button', { name: 'accept', exact: true }).click();
  for (const file of await begun) {
    assert.ok(file.suggestedFilename() in expected, file.suggestedFilename());
    assert.equal(digest(await readFile(await file.path())), digest(expected[file.suggestedFilename()]));
  }
}
try {
  const a = await page({ holdPeerConnectionOpen: true });
  const b = await page({ link: await roomLink(a) });
  await Promise.all([connected(a), connected(b)]);
  assert.equal(await a.locator('#room-qr canvas').count(), 1, 'a code to scan');
  console.log('PASS a room and its link on arrival, then a real WebRTC connection');
  const payload = randomBytes(2 * 1024 * 1024 + 7);
  await choose(a, [{ name: 'random.bin', mimeType: 'application/octet-stream', buffer: payload }, { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }]);
  await accept(b, { 'random.bin': payload, 'empty.txt': Buffer.alloc(0) });
  await b.locator('.download-file').filter({ hasText: 'random.bin · saved to downloads' }).waitFor();
  await a.locator('.transfer__state').filter({ hasText: /^sent to/ }).waitFor();
  console.log('PASS batched binary + zero-byte file saved to downloads, exact SHA-256, sender receipt');

  await b.getByRole('button', { name: /^send text to / }).click();
  await b.locator('#text').fill('hello from the other device, 𓁹 <script>not executable</script>');
  await b.locator('#send-text').click(); await a.getByRole('button', { name: 'accept', exact: true }).click();
  await a.locator('.received-files pre').waitFor();
  assert.equal(await a.locator('.received-files pre').textContent(), 'hello from the other device, 𓁹 <script>not executable</script>');
  console.log('PASS reverse text transfer and literal HTML');

  await choose(a, [{ name: 'decline.txt', mimeType: 'text/plain', buffer: Buffer.from('decline') }]);
  await b.getByRole('button', { name: 'decline', exact: true }).click();
  await a.locator('.transfer__state').filter({ hasText: 'not sent · declined' }).waitFor();
  await choose(a, [{ name: 'cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('cancel') }]);
  await b.getByRole('button', { name: 'accept', exact: true }).waitFor();
  await a.getByRole('button', { name: 'cancel', exact: true }).click();
  await b.locator('.transfer__state').filter({ hasText: 'sender cancelled' }).waitFor();
  console.log('PASS decline and sender cancellation');

  // Taking a new link abandons the room: the old link is dead and the device
  // that had it drops away, until it opens the new one.
  const stale = await roomLink(a);
  await a.evaluate(() => { globalThis.__holdPeerConnectionOpenForTest = true; });
  await a.locator('#new-link').click();
  await a.waitForFunction(old => document.querySelector('#room-link').value !== old, stale);
  const link = await roomLink(a);
  assert.notEqual(link, stale);
  await b.waitForFunction(() => document.querySelectorAll('.device').length === 0);
  await a.evaluate(() => { globalThis.__holdPeerConnectionOpenForTest = false; });
  await b.goto(link); await Promise.all([connected(a), connected(b)]);
  assert.equal(await a.locator('#room-qr canvas').count(), 1);
  console.log('PASS a new link replaces the room, and the old one connects nobody');

  // Simultaneous transfers work in both directions over one ordered channel.
  await Promise.all([choose(a, [{ name: 'from-a.txt', mimeType: 'text/plain', buffer: Buffer.from('alpha') }]), choose(b, [{ name: 'from-b.txt', mimeType: 'text/plain', buffer: Buffer.from('beta') }])]);
  await Promise.all([accept(a, { 'from-b.txt': Buffer.from('beta') }), accept(b, { 'from-a.txt': Buffer.from('alpha') })]);
  console.log('PASS simultaneous bidirectional transfers');

  for (const width of [320, 375, 414, 768, 1280]) {
    await a.setViewportSize({ width, height: 900 });
    const overflow = await a.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    assert.ok(overflow.scroll <= overflow.client, `overflow at ${width}: ${JSON.stringify(overflow)}`);
    await a.evaluate(() => window.scrollTo(0, 0));
    await a.screenshot({ path: `${output}/share-${width}.png`, fullPage: true });
  }
  console.log('PASS responsive layout at 320, 375, 414, 768, 1280px');
  await b.reload(); await Promise.all([connected(a), connected(b)]);
  console.log('PASS reload reconnect');

  // Losing the discovery stream must resume the same session: same name, no new
  // device appearing on the other side, and a transfer still works afterwards.
  const proxy = await cuttableProxy(base);
  const viaProxy = new URL(b.url()); viaProxy.host = new URL(proxy.base).host;
  await b.goto(viaProxy.href); await Promise.all([connected(a), connected(b)]);
  const nameBefore = await b.locator('#your-name').textContent();
  const idsBefore = await a.evaluate(() => document.querySelectorAll('.device').length);
  proxy.cut();
  await b.waitForFunction(() => document.querySelector('#status').textContent === 'reconnecting…', null, { timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 3000));   // stay down across several retries
  proxy.restore();
  await b.waitForFunction(() => document.querySelector('#status').textContent !== 'reconnecting…', null, { timeout: 30000 });
  assert.equal(await b.locator('#your-name').textContent(), nameBefore, 'device kept its identity');
  await Promise.all([connected(a), connected(b)]);
  assert.equal(await a.evaluate(() => document.querySelectorAll('.device').length), idsBefore, 'no duplicate device appeared');
  await choose(a, [{ name: 'after-blip.txt', mimeType: 'text/plain', buffer: Buffer.from('still here') }]);
  await accept(b, { 'after-blip.txt': Buffer.from('still here') });
  const direct = new URL(b.url()); direct.host = new URL(base).host;
  await b.goto(direct.href); await Promise.all([connected(a), connected(b)]);
  proxy.close();
  console.log('PASS discovery stream loss resumes the same session and keeps working');
  // Slow the sender's reads, so there is time to cancel in the middle.
  await a.evaluate(() => {
    const read = globalThis.__read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () { await new Promise(r => setTimeout(r, 400)); return read.call(this); };
  });
  /* Count every time either side loses its channel: cancelling one transfer
     must not take the connection, or anything else on it, down with it. */
  for (const p of [a, b]) await p.evaluate(() => {
    globalThis.__drops = 0;
    new MutationObserver(() => { if (document.querySelector('.device__action')?.textContent !== 'ready') globalThis.__drops++; })
      .observe(document.querySelector('#devices'), { subtree: true, characterData: true, childList: true });
  });
  await choose(a, [{ name: 'cancel-during.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(32 * 1024 * 1024, 37) }]);
  const partial = downloads(b, 1);
  await b.getByRole('button', { name: 'accept', exact: true }).click();
  await b.locator('.transfer__state').filter({ hasText: /^receiving ·/ }).waitFor();
  await b.getByRole('button', { name: 'cancel', exact: true }).click();
  await b.locator('.transfer__state').filter({ hasText: 'transfer cancelled.' }).waitFor();
  await a.locator('.transfer__state').filter({ hasText: /^not sent · cancelled by / }).waitFor();
  // The browser marks the half-saved download failed rather than keeping it.
  assert.ok(await (await partial)[0].failure(), 'the partial download fails');
  assert.equal(await b.getByRole('link', { name: 'download cancel-during.bin', exact: true }).count(), 0);
  await choose(a, [{ name: 'after-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('clean retry') }]);
  await accept(b, { 'after-cancel.txt': Buffer.from('clean retry') });
  console.log('PASS mid-transfer receiver cancellation stops the sender, fails the partial download, keeps the connection');

  // The sender cancelling in the middle drops the batch on both sides, and the connection carries on.
  await choose(a, [{ name: 'sender-cancels.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(32 * 1024 * 1024, 41) }]);
  const dropped = downloads(b, 1);
  await b.getByRole('button', { name: 'accept', exact: true }).click();
  await a.locator('.transfer__state').filter({ hasText: /^sending ·/ }).waitFor();
  await a.getByRole('button', { name: 'cancel', exact: true }).click();
  await b.locator('.transfer__state').filter({ hasText: 'sender cancelled' }).waitFor();
  assert.ok(await (await dropped)[0].failure(), 'the partial download fails');
  await a.evaluate(() => { Blob.prototype.arrayBuffer = globalThis.__read; });
  await choose(b, [{ name: 'the-other-way.txt', mimeType: 'text/plain', buffer: Buffer.from('both ways') }]);
  await accept(a, { 'the-other-way.txt': Buffer.from('both ways') });
  assert.deepEqual(await Promise.all([a, b].map(p => p.evaluate(() => globalThis.__drops))), [0, 0], 'no reconnection');
  console.log('PASS mid-transfer sender cancellation, without reconnecting');

  // A transfer larger than memory would allow is saved to the downloads as it
  // arrives: the download begins before the first byte, and nothing is kept
  // in this site's storage on the way.
  const bigPath = output + '/big.bin', big = randomFillSync(Buffer.allocUnsafe(300 * 1024 * 1024 + 5));
  await writeFile(bigPath, big);
  const before = await stored(a);
  await choose(b, [bigPath]);
  const begun = downloads(a, 1);
  await a.getByRole('button', { name: 'accept', exact: true }).click();
  const [saving] = await begun;
  assert.doesNotMatch(await a.locator('.transfer__state').first().textContent(), /^received/, 'the download begins while the file is still arriving');
  assert.equal(saving.suggestedFilename(), 'big.bin');
  assert.equal(digest(await readFile(await saving.path())), digest(big));
  await a.locator('.download-file').filter({ hasText: 'big.bin · saved to downloads' }).waitFor({ timeout: 240000 });
  await b.locator('.transfer__state').filter({ hasText: /^sent to/ }).first().waitFor();
  assert.ok((await stored(a)).bytes < before.bytes + 1024 * 1024, 'nothing kept in storage');
  console.log('PASS 300 MB saved to downloads as it arrived, with receiver pacing, exact SHA-256');

  // Where the browser cannot save a download as it arrives, as Safari cannot,
  // the same transfer goes to this site's storage, and removing it frees the space.
  const keeper = await page({ link: await roomLink(a), noDownloads: true });
  await Promise.all([connected(a, 2), connected(b, 2), connected(keeper, 2)]);
  const keeperName = await keeper.locator('#your-name').textContent(), held = await stored(keeper);
  await choose(b, [bigPath], 'send files to ' + keeperName);
  await keeper.getByRole('button', { name: 'accept', exact: true }).click();
  await keeper.getByRole('link', { name: 'download big.bin', exact: true }).waitFor({ timeout: 240000 });
  assert.ok((await stored(keeper)).bytes >= held.bytes + big.length, 'the file is on disk');
  await download(keeper, 'big.bin', big);
  await keeper.locator('.transfer').filter({ hasText: 'big.bin' }).getByRole('button', { name: 'remove', exact: true }).click();
  await storedUntil(keeper, now => now.bytes < held.bytes + big.length);
  await keeper.goto('about:blank'); await keeper.context().close();
  await Promise.all([connected(a), connected(b)]);
  console.log('PASS 300 MB received to storage without downloads, exact SHA-256, removed from disk');

  // A folder left by a closed tab is cleared by the next one; a live tab's is not.
  await a.evaluate(async () => {
    const share = await (await navigator.storage.getDirectory()).getDirectoryHandle('share', { create: true });
    await (await share.getDirectoryHandle('abandoned', { create: true })).getFileHandle('left.bin', { create: true });
  });
  const live = (await stored(a)).folders.filter(name => name !== 'abandoned');
  const next = await a.context().newPage(); await next.goto(base + '/share');
  await storedUntil(a, now => !now.folders.includes('abandoned'));
  const after = await stored(a);
  for (const name of live) assert.ok(after.folders.includes(name), 'a live tab keeps its folder');
  await next.close();
  console.log('PASS a closed tab\'s storage is cleared, a live tab\'s kept');

  // Without the storage, received files live in memory as before: more than
  // 256 MB is turned away at once, and a smaller transfer still arrives.
  const memory = await page({ link: await roomLink(a), noStorage: true, noDownloads: true });
  await Promise.all([connected(a, 2), connected(b, 2), connected(memory, 2)]);
  const memoryName = await memory.locator('#your-name').textContent();
  await choose(b, [bigPath], 'send files to ' + memoryName);
  await b.locator('.transfer__state').filter({ hasText: 'not sent · too large for this browser; it takes up to 256 MB' }).waitFor();
  await choose(b, [{ name: 'to-memory.txt', mimeType: 'text/plain', buffer: Buffer.from('held in memory') }], 'send files to ' + memoryName);
  await memory.getByRole('button', { name: 'accept', exact: true }).click();
  await download(memory, 'to-memory.txt', Buffer.from('held in memory'));
  /* Leave as a closing tab does, so the others drop it at once rather than
     when its connection times out. */
  await memory.goto('about:blank'); await memory.context().close();
  await Promise.all([connected(a), connected(b)]);
  console.log('PASS without storage, over 256 MB is refused and smaller transfers are held in memory');

  // Keyboard entry and native modal dismissal stay on this tool.
  await a.getByRole('button', { name: /^send text to / }).focus();
  await a.keyboard.press('Enter'); await a.locator('#text-dialog').waitFor();
  assert.equal(await a.locator('#text').evaluate(e => e === document.activeElement), true);
  await a.keyboard.press('Escape');
  assert.equal(await a.locator('#text-dialog').evaluate(e => e.open), false);
  assert.equal(new URL(a.url()).pathname, '/share');
  console.log('PASS keyboard text sharing and Escape dismissal');
  // A connection that has been gone for half a minute takes the link with it.
  const doomed = await roomLink(a);
  await b.close();
  await a.waitForFunction(old => document.querySelector('#room-link').value !== old, doomed, { timeout: 60000 });
  assert.notEqual(await roomLink(a), doomed);
  assert.match(await a.locator('#empty-note').textContent(), /old one no longer works/);
  const late = await page({ link: doomed });
  await late.waitForFunction(() => document.querySelector('#status').textContent === 'room open');
  assert.equal(await late.locator('.device').count(), 0, 'the abandoned link reaches nobody');
  console.log('PASS a severed connection replaces the link');

  // When the service knows the visitor's network, two devices on it meet
  // without a link, and a device on another network does not see them.
  const nearby = createEyesServer({ shareOptions: { trustCloudflare: true } });
  await new Promise(resolve => nearby.server.listen(0, '127.0.0.1', resolve));
  const home = 'http://127.0.0.1:' + nearby.server.address().port + '/share';
  try {
    const first = await page({ link: home, address: '203.0.113.7' }), second = await page({ link: home, address: '203.0.113.7' });
    const elsewhere = await page({ link: home, address: '198.51.100.20' });
    await Promise.all([connected(first), connected(second)]);
    assert.match(await first.locator('#empty-note').textContent(), /on this network/);
    assert.notEqual(await first.locator('#room-link').inputValue(), await second.locator('#room-link').inputValue(), 'each still has its own link');
    await elsewhere.waitForFunction(() => document.querySelector('#status').textContent === 'room open');
    assert.equal(await elsewhere.locator('.device').count(), 0, 'another network sees nobody');
    await choose(first, [{ name: 'nearby.txt', mimeType: 'text/plain', buffer: Buffer.from('same wi-fi') }]);
    await accept(second, { 'nearby.txt': Buffer.from('same wi-fi') });
    console.log('PASS devices on one known network meet without a link, others do not');

    // A device that moves to that network, as a phone joining the Wi-Fi does,
    // finds the devices there without reloading.
    assert.equal(await elsewhere.locator('#device-where').textContent(), 'nearby or in this room');
    await elsewhere.context().setExtraHTTPHeaders({ 'CF-Connecting-IP': '203.0.113.7' });
    await elsewhere.evaluate(() => window.dispatchEvent(new Event('online')));
    await Promise.all([connected(first, 2), connected(second, 2), connected(elsewhere, 2)]);
    for (const p of [first, second, elsewhere]) await p.context().close();
  } finally { await nearby.close(); }
  console.log('PASS a device that changes network finds the devices on the new one');

  // Behind something that holds the event stream back until it ends, the
  // pages hear nothing, then collect their events in short requests instead.
  const holding = await bufferingProxy(base);
  try {
    const first = await page({ link: holding.base + '/share' });
    const second = await page({ link: (await roomLink(first)).replace(base, holding.base) });
    await Promise.all([connected(first), connected(second)]);
    assert.ok(requests.some(r => r.url.startsWith(holding.base) && r.url.includes('/events?poll=1&')), 'collected in short requests');
    await choose(first, [{ name: 'held-back.txt', mimeType: 'text/plain', buffer: Buffer.from('through a buffering proxy') }]);
    await accept(second, { 'held-back.txt': Buffer.from('through a buffering proxy') });
    for (const p of [first, second]) await p.context().close();
  } finally { holding.close(); }
  console.log('PASS a network that holds the event stream back still finds devices');

  // A web view without WebRTC, as Ubuntu's WebKitGTK is. The site
  // says what share needs; a copy served elsewhere, as the desktop app is,
  // names the site the way the app does and offers the same room there.
  const room = '0123456789abcdef01234567';
  for (const publicOrigin of ['', 'https://eyes.example']) {
    const context = await browser.newContext();
    await context.addInitScript(origin => {
      delete window.RTCPeerConnection;
      let site;
      if (origin) Object.defineProperty(window, 'SITE', { configurable: true, get: () => site, set: value => { site = value; if (value) value.publicOrigin = origin; } });
    }, publicOrigin);
    const p = await context.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto(base + '/share#room=' + room);
    await p.waitForFunction(() => document.querySelector('#status').textContent === 'unavailable');
    if (publicOrigin) assert.equal(await p.locator('#err a').getAttribute('href'), publicOrigin + '/share#room=' + room);
    else {
      assert.equal(await p.locator('#err a').count(), 0);
      assert.match(await p.locator('#err').textContent(), /browser that supports WebRTC/);
    }
    await context.close();
  }
  console.log('PASS without WebRTC, a copy served elsewhere offers the room on the site');

  assert.deepEqual(errors, []);
  assert.ok(requests.every(r => r.bytes < 65536));
  console.log('PASS no page errors or file payloads in signaling requests');
} finally { await browser.close(); }
