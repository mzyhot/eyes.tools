// Run with a local server: SHARE_TEST_URL=http://127.0.0.1:8877 node tests/share-browser.mjs
// Install Playwright for development, or set PLAYWRIGHT_MODULE to its module path.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const base = process.env.SHARE_TEST_URL || 'http://127.0.0.1:8877';
const output = process.env.SHARE_TEST_OUTPUT || '/tmp/eyes-share-tests';
await mkdir(output, { recursive: true });
const errors = [], requests = [];
/* Every page opens a room of its own; a second device joins by opening the
   first one's link, which is how share now works — there is no discovery. */
async function page({ holdPeerConnectionOpen = false, link = '' } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
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
async function choose(p, files) {
  const chooser = p.waitForEvent('filechooser'); await p.getByRole('button', { name: /^send files to / }).first().click(); await (await chooser).setFiles(files);
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
async function download(p, name, expected) {
  const ready = p.waitForEvent('download'); await p.getByRole('link', { name: 'download ' + name, exact: true }).click();
  const file = await ready; assert.equal(file.suggestedFilename(), name);
  assert.equal(digest(await readFile(await file.path())), digest(expected));
}
try {
  const a = await page({ holdPeerConnectionOpen: true });
  const b = await page({ link: await roomLink(a) });
  await Promise.all([connected(a), connected(b)]);
  assert.equal(await a.locator('#room-qr canvas').count(), 1, 'a code to scan');
  console.log('PASS a room and its link on arrival, then a real WebRTC connection');
  const payload = randomBytes(2 * 1024 * 1024 + 7);
  await choose(a, [{ name: 'random.bin', mimeType: 'application/octet-stream', buffer: payload }, { name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) }]);
  await b.getByRole('button', { name: 'accept', exact: true }).click();
  await b.getByRole('link', { name: 'download random.bin', exact: true }).waitFor();
  await download(b, 'random.bin', payload); await download(b, 'empty.txt', Buffer.alloc(0));
  await a.locator('.transfer__state').filter({ hasText: /^sent to/ }).waitFor();
  console.log('PASS batched binary + zero-byte file, exact SHA-256, sender receipt');

  await b.getByRole('button', { name: /^send text to / }).click();
  await b.locator('#text').fill('hello from the other device — 𓁹 <script>not executable</script>');
  await b.locator('#send-text').click(); await a.getByRole('button', { name: 'accept', exact: true }).click();
  await a.locator('.received-files pre').waitFor();
  assert.equal(await a.locator('.received-files pre').textContent(), 'hello from the other device — 𓁹 <script>not executable</script>');
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
  await Promise.all([a.getByRole('button', { name: 'accept', exact: true }).click(), b.getByRole('button', { name: 'accept', exact: true }).click()]);
  await a.getByRole('link', { name: 'download from-b.txt', exact: true }).waitFor();
  await b.getByRole('link', { name: 'download from-a.txt', exact: true }).waitFor();
  await download(a, 'from-b.txt', Buffer.from('beta')); await download(b, 'from-a.txt', Buffer.from('alpha'));
  console.log('PASS simultaneous bidirectional transfers');

  for (const theme of ['dark', 'light']) {
    await a.evaluate(t => document.documentElement.dataset.theme = t, theme);
    for (const width of [320, 375, 414, 768, 1280]) {
      await a.setViewportSize({ width, height: 900 });
      const overflow = await a.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      assert.ok(overflow.scroll <= overflow.client, `${theme} overflow at ${width}: ${JSON.stringify(overflow)}`);
      await a.evaluate(() => window.scrollTo(0, 0));
      await a.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true });
    }
  }
  console.log('PASS responsive layout in dark/light at 320, 375, 414, 768, 1280px');
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
  await b.getByRole('button', { name: 'accept', exact: true }).click();
  await download(b, 'after-blip.txt', Buffer.from('still here'));
  const direct = new URL(b.url()); direct.host = new URL(base).host;
  await b.goto(direct.href); await Promise.all([connected(a), connected(b)]);
  proxy.close();
  console.log('PASS discovery stream loss resumes the same session and keeps working');
  await a.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function () { await new Promise(r => setTimeout(r, 4)); return read.call(this); };
  });
  await choose(a, [{ name: 'cancel-during.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(16 * 1024 * 1024, 37) }]);
  await b.getByRole('button', { name: 'accept', exact: true }).click();
  await b.locator('.transfer__state').filter({ hasText: /^receiving ·/ }).waitFor();
  await b.getByRole('button', { name: 'cancel', exact: true }).click();
  await b.locator('.transfer__state').filter({ hasText: 'transfer cancelled.' }).waitFor();
  // Cancelling closes the channel on purpose; both sides reconnect on their own.
  await Promise.all([connected(a), connected(b)]);
  assert.equal(await b.getByRole('link', { name: 'download cancel-during.bin', exact: true }).count(), 0);
  await choose(a, [{ name: 'after-cancel.txt', mimeType: 'text/plain', buffer: Buffer.from('clean retry') }]);
  await b.getByRole('button', { name: 'accept', exact: true }).click();
  await b.getByRole('link', { name: 'download after-cancel.txt', exact: true }).waitFor();
  await download(b, 'after-cancel.txt', Buffer.from('clean retry'));
  console.log('PASS mid-transfer receiver cancellation, no partial download, retry');

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

  assert.deepEqual(errors, []);
  assert.ok(requests.every(r => r.bytes < 65536));
  console.log('PASS no page errors or file payloads in signaling requests');
} finally { await browser.close(); }
