/* 𓁹𓁹: share's downloads, a service worker.
 *
 * A received file goes to the browser's downloads while it is still
 * arriving, the way a file from any website does: the browser writes it into
 * a partial file (`.part` in Firefox, `.crdownload` in Chrome) that grows as
 * the bytes come in and becomes the real file when the last one lands. Only
 * a response can start a download, and only this worker can answer a request
 * with bytes that do not exist yet, so the share page hands each file to it
 * as a stream and then opens the stream's address in a hidden frame.
 *
 * The worker answers nothing but its own scope, `/share-download/`, which no
 * page lives under, so it never stands between the site and its visitors.
 *
 * The page talks to it in two ways. `save`, posted to the worker with a port,
 * registers one file: its id, name and size. Over that port the page then
 * sends `chunk` (an ArrayBuffer and its running count), `end` and `abort`,
 * and hears `started` when the browser has asked for the file, `more` with
 * the count of chunks taken (a chunk is taken while the stream's queue has
 * room, so a slow disk holds the transfer back), and `cancelled` when the
 * person cancels the download. `ping` keeps the worker alive while a file is
 * open: a browser stops an idle worker after about thirty seconds, and the
 * bytes moving through a port do not count as activity.
 */
'use strict';

/* What a stream may hold that the download has not yet written. */
const HIGH_WATER = 8 * 1024 * 1024;
/* How long a file waits to be asked for, and how long a request waits for
   its file, since the two arrive by separate routes in no fixed order. */
const WAIT_MS = 5000;
const MAX_SAVES = 256;

const saves = new Map(), early = new Map();

/* No page is ever controlled by this worker, so a new version can take over at
   once without leaving anyone on the old one. */
self.addEventListener('install', () => self.skipWaiting());

/** The name a browser saves under, in both of the forms a download header allows. */
function disposition(name) {
  const plain = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${plain}"; filename*=UTF-8''${encoded}`;
}

/** Register one file to be saved, and wire its port to a stream. */
function register({ id, name, size }, port) {
  if (!/^[a-f0-9]{24}$/.test(id) || typeof name !== 'string' || !name || name.length > 255 || !Number.isSafeInteger(size) || size < 0 || saves.size >= MAX_SAVES) {
    port.postMessage({ t: 'refused' });
    return;
  }
  let controller, owed = 0, done = false;
  const finish = () => { done = true; saves.delete(id); port.onmessage = null; };
  const stream = new ReadableStream({
    start(c) { controller = c; },
    /* Room again: take what was waiting. */
    pull() { if (owed) { port.postMessage({ t: 'more', n: owed }); owed = 0; } },
    cancel() { if (!done) { finish(); port.postMessage({ t: 'cancelled' }); } }
  }, new ByteLengthQueuingStrategy({ highWaterMark: HIGH_WATER }));
  port.onmessage = ({ data }) => {
    if (done || !data) return;
    if (data.t === 'chunk' && data.chunk instanceof ArrayBuffer) {
      controller.enqueue(new Uint8Array(data.chunk));
      if (controller.desiredSize > 0) port.postMessage({ t: 'more', n: data.n });
      else owed = data.n;
    } else if (data.t === 'end') {
      controller.close();
      if (owed) port.postMessage({ t: 'more', n: owed });
      finish();
    } else if (data.t === 'abort') {
      controller.error(new Error('the transfer stopped'));
      finish();
    }
  };
  const entry = { id, name, size, stream, port };
  const waiting = early.get(id);
  if (waiting) { early.delete(id); waiting(entry); }
  else {
    saves.set(id, entry);
    /* Never asked for, as when the browser blocked the download: let it go. */
    setTimeout(() => { if (saves.get(id) === entry && !done) { finish(); controller.error(new Error('never started')); } }, WAIT_MS * 12);
  }
  port.postMessage({ t: 'ready' });
}

/** The file a request names, once it has been registered, or null. */
function take(id) {
  const entry = saves.get(id);
  if (entry) { saves.delete(id); return Promise.resolve(entry); }
  if (early.size >= MAX_SAVES) return Promise.resolve(null);
  return new Promise(resolve => {
    early.set(id, resolve);
    setTimeout(() => { if (early.get(id) === resolve) { early.delete(id); resolve(null); } }, WAIT_MS);
  });
}

self.addEventListener('message', event => {
  const data = event.data;
  if (data?.t === 'save' && event.ports[0]) register(data, event.ports[0]);
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname) || event.request.method !== 'GET') return;
  const id = url.pathname.slice(scope.pathname.length).split('/')[0];
  event.respondWith(take(id).then(entry => {
    /* Nothing to save: an empty answer leaves the frame, and the page, as they are. */
    if (!entry) return new Response(null, { status: 204 });
    entry.port.postMessage({ t: 'started' });
    return new Response(entry.stream, { headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': disposition(entry.name),
      'Content-Length': String(entry.size),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    } });
  }));
});
