/* 𓁹𓁹 — the Node server.
 *
 * Despite the filename this is the production server for self-hosted
 * deployments (see `deploy/README.md`): static hosts can serve the pages, but
 * only this process provides share discovery.
 * It has no npm runtime dependencies and no build step, so what runs in
 * production is the file in the repository.
 *
 * What it does, in the order a request meets it:
 *
 *   Security headers, unconditionally, before routing. Every response carries a
 *   content security policy, framing and sniffing refusals, and a permissions
 *   policy. HTML additionally gets `'sha256-…'` entries for its own inline
 *   scripts, computed from the file, so the pages need no `'unsafe-inline'`.
 *   Rewriting HTML in front of this server — an edge "optimizer", an injected
 *   analytics tag — invalidates those hashes and breaks the page.
 *
 *   Routing. `/healthz`, then the API modules, then pages and static files.
 *   Anything that is not a GET or HEAD past the APIs is refused. Pages have clean
 *   addresses — `/share`, not `/t/share.html` — and the old spellings redirect.
 *
 *   Publication by allow list. `PUBLIC_FILES` is built at startup from the
 *   root assets in `public-files.mjs` plus the tool pages found in `t/`.
 *   Source modules, tests, dotfiles, backups and deployment configuration are
 *   not public, and stay that way when new ones are added — there is no deny
 *   list to maintain.
 *
 *   Path containment. The request path is decoded, rejected if it contains a
 *   traversal segment, a NUL or a backslash, resolved, and then checked again
 *   after `realpath` so a symlink cannot escape the project directory.
 *
 * Performance is handled in three places, all of which matter for a small
 * self-hosted instance:
 *
 *   Assets are cached in memory, keyed by path and validated against the file's
 *   mtime and size, so a page is read and its CSP hashed once per edit rather
 *   than once per request.
 *
 *   Text assets are compressed once — brotli and gzip — and the result is
 *   cached alongside the original. The vendored libraries the tool pages load
 *   are the bulk of the bytes this server sends, and they compress to roughly a
 *   quarter of their size. Compression runs on the thread pool, so a cold file
 *   never blocks the event loop.
 *
 *   Every asset carries an ETag and `Last-Modified`, and conditional requests
 *   are answered with 304. Combined with `Cache-Control: no-cache` — revalidate
 *   always, but reuse the cached copy when unchanged — a repeat visit transfers
 *   headers only.
 */

import { createReadStream, realpathSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import { promisify } from "node:util";

import { API_MODULES } from "./api-modules.mjs";
import { PUBLIC_ROOT_FILES } from "./public-files.mjs";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8777;
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url));
const REAL_PROJECT_ROOT = await realpath(PROJECT_ROOT);
const NOT_FOUND_BODY = await readFile(resolve(PROJECT_ROOT, "404.html"));

const MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".ogg", "audio/ogg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

/* The three published files with no extension. Typed explicitly so a browser
   shows them instead of downloading them — `nosniff` means an unknown type is
   never guessed at. */
const EXTENSIONLESS_TYPES = new Map([
  ["LICENSE", "text/plain; charset=utf-8"],
  ["ADDENDUM", "text/plain; charset=utf-8"],
  ["THIRDPARTYLICENSES", "text/plain; charset=utf-8"]
]);

// Only deployable assets are public. New source files, backups, and service
// configuration stay private without maintaining a growing deny list.
const PUBLIC_FILES = new Set([
  ...PUBLIC_ROOT_FILES,
  ...(await readdir(resolve(PROJECT_ROOT, "t"))).filter(name => /^[a-z0-9-]+\.html$/.test(name)).map(name => "t/" + name)
]);

/* Clean page URLs. Every tool is published at `/<slug>` and the index at `/`.
   The files stay where they are, in `t/`, because the site must also open
   straight from disk, where there is no server to do this mapping. */
const PAGES = new Map([
  ["/", "index.html"],
  ...[...PUBLIC_FILES].filter(name => name.startsWith("t/")).map(name => ["/" + name.slice(2, -".html".length), name])
]);

/**
 * The canonical address for a request path that has one, or null.
 *
 * Old `/t/<slug>.html` links, `/index.html` and a trailing slash all redirect,
 * so bookmarks and printed QR codes keep working and each page has exactly one
 * address. The browser carries the fragment across a redirect, which is what
 * keeps an old `#room=` share link intact.
 * @param {string} pathname The raw request path.
 * @returns {string|null}
 */
function canonicalPath(pathname) {
  if (pathname === "/index.html") return "/";
  const legacy = /^\/t\/([a-z0-9-]+)\.html$/.exec(pathname);
  if (legacy && PAGES.has("/" + legacy[1])) return "/" + legacy[1];
  const slashed = /^\/([a-z0-9-]+)\/$/.exec(pathname);
  if (slashed && PAGES.has("/" + slashed[1])) return "/" + slashed[1];
  return null;
}

/* Cache of parsed, hashed and compressed assets, keyed by resolved path and
   invalidated by the file's own mtime and size. Bounded by PUBLIC_FILES, which
   is fixed at startup, so it cannot grow with traffic. */
const assetCache = new Map();

/* Types worth compressing. Everything else the site publishes — png, webp,
   woff2 — is already compressed, and running deflate over it costs CPU to make
   the response marginally larger. */
const COMPRESSIBLE_TYPE = /^(?:text\/|image\/svg|application\/(?:json|wasm))/;
/* Below roughly one packet the framing overhead outweighs any saving. */
const COMPRESS_MIN_BYTES = 1024;
/* Assets larger than this are streamed from disk instead of held in memory. */
const COMPRESS_MAX_BYTES = 4 * 1024 * 1024;

/* `script-src` stays last: each page's inline-script hashes are appended to
   it (see pagePolicy), and the static hosts append 'unsafe-inline' instead. */
export const CSP = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; " +
  "img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self' https://drand.cloudflare.com; " +
  "worker-src 'self' blob:; script-src 'self'";

/* The headers every response carries. `scripts/static-routes.mjs` writes the
   static hosts' headers from this same table. */
export const SECURITY_HEADER_VALUES = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
});

/* Pre-split so the per-request path is a flat loop over pairs rather than an
   Object.entries allocation. */
const SECURITY_HEADERS = Object.entries(SECURITY_HEADER_VALUES);

/** Apply the headers every response gets, before anything decides what to send. */
function securityHeaders(response) {
  for (const [name, value] of SECURITY_HEADERS) response.setHeader(name, value);
}

/**
 * Validate a port from the command line or the environment.
 * @param {string|undefined} value
 * @returns {number}
 * @throws {TypeError} On anything that is not a port number.
 */
function parsePort(value) {
  if (value === undefined) return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) throw new TypeError("port must be an integer from 1 to 65535");
  const port = Number(value);
  if (port < 1 || port > 65535) throw new TypeError("port must be an integer from 1 to 65535");
  return port;
}

function setHeaders(response, headers) {
  for (const name of Object.keys(headers)) response.setHeader(name, headers[name]);
}

/**
 * Send a complete in-memory body, honouring HEAD by sending headers only.
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} type Content-Type.
 * @param {Buffer} body
 * @param {string} [method="GET"] Request method.
 * @param {Object<string,string|number>} [extraHeaders]
 */
function sendBuffer(response, status, type, body, method = "GET", extraHeaders = {}) {
  response.statusCode = status;
  setHeaders(response, {
    "Cache-Control": "no-store",
    "Content-Length": body.byteLength,
    "Content-Type": type,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  if (method === "HEAD") response.end();
  else response.end(body);
}

function sendText(response, status, message, method = "GET", extraHeaders = {}) {
  sendBuffer(response, status, "text/plain; charset=utf-8", Buffer.from(message), method, extraHeaders);
}

/**
 * Derive the script-src hashes a page needs from the page itself.
 *
 * Every inline `<script>` without a `src` is hashed and added to the policy, so
 * the pages get the protection of a strict CSP while staying single files that
 * also open from `file://`. A page with no inline script — the index, the 404,
 * a redirect stub — keeps the base policy unchanged.
 * @param {Buffer} body The HTML.
 * @returns {string} The full policy for that page.
 */
function pagePolicy(body) {
  const hashes = [...body.toString("utf8").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter(match => !/\bsrc\s*=/i.test(match[1]))
    .map(match => "'sha256-" + createHash("sha256").update(match[2]).digest("base64") + "'");
  return hashes.length ? CSP + " " + hashes.join(" ") : CSP;
}

/* The 404 body never changes, so hash its inline scripts once at startup rather
   than on every miss — and misses are the requests most likely to arrive in
   bulk. */
const NOT_FOUND_POLICY = pagePolicy(NOT_FOUND_BODY);

function notFound(response, method) {
  sendBuffer(response, 404, "text/html; charset=utf-8", NOT_FOUND_BODY, method, { "Content-Security-Policy": NOT_FOUND_POLICY });
}

/** Whether a resolved path is inside the project directory. */
function isInsideProject(filePath) {
  const rel = relative(REAL_PROJECT_ROOT, filePath);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

/**
 * The publication test: no traversal or hidden segments, and the joined path is
 * on the allow list.
 * @param {string[]} segments Path segments, empties removed.
 */
function hasBlockedSegment(segments) {
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) return true;
  return !PUBLIC_FILES.has(segments.join("/"));
}

/**
 * Turn a request URL into a path to serve, or null to refuse.
 * @param {URL} url
 * @returns {string|null} Absolute candidate path; still unverified on disk.
 */
function requestedStaticPath(url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (error) { return null; }

  if (pathname === "/") pathname = "/index.html";
  if (!pathname.startsWith("/") || pathname.includes("\0") || pathname.includes("\\")) return null;

  const segments = pathname.split("/").filter(Boolean);
  if (hasBlockedSegment(segments)) return null;

  const filePath = resolve(PROJECT_ROOT, "." + pathname);
  return isInsideProject(filePath) ? filePath : null;
}

/** The Content-Type for a published file, or octet-stream if we do not know it. */
function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext) return MIME_TYPES.get(ext) || "application/octet-stream";
  return EXTENSIONLESS_TYPES.get(filePath.slice(filePath.lastIndexOf(sep) + 1)) || "application/octet-stream";
}

/**
 * Which encoding to send, given what the client offered.
 *
 * Brotli is preferred where it is offered: it is materially smaller than gzip
 * on this site's text, and every browser that speaks it also caches it. A
 * coding listed with `q=0` is refused, not offered, so it is never chosen.
 * @param {string|undefined} header The Accept-Encoding request header.
 * @returns {"br"|"gzip"|null}
 */
function negotiateEncoding(header) {
  if (!header) return null;
  const accepted = new Set();
  for (const part of header.toLowerCase().split(",")) {
    const [coding, ...params] = part.split(";").map(value => value.trim());
    const quality = params.find(param => param.startsWith("q="));
    if (coding && !(quality && Number(quality.slice(2)) === 0)) accepted.add(coding);
  }
  if (accepted.has("br")) return "br";
  if (accepted.has("gzip")) return "gzip";
  return null;
}

/**
 * Load an asset into the cache, or return the cached entry when the file on
 * disk still matches it.
 *
 * The entry holds the raw bytes, the content type, a strong ETag over the
 * bytes, the per-page CSP for HTML, and a map of encoding → compressed buffer
 * that fills in lazily as clients ask for each encoding.
 *
 * @param {string} filePath Resolved, verified path.
 * @param {import("node:fs").Stats} fileStat Its stat, already taken.
 * @returns {Promise<object>} The cache entry.
 */
async function loadAsset(filePath, fileStat) {
  const cached = assetCache.get(filePath);
  if (cached && cached.modified === fileStat.mtimeMs && cached.size === fileStat.size) return cached;

  const body = await readFile(filePath);
  const type = contentType(filePath);
  const entry = {
    body,
    type,
    modified: fileStat.mtimeMs,
    size: fileStat.size,
    lastModified: fileStat.mtime.toUTCString(),
    /* Strong validator: derived from the bytes, so two deployments of identical
       content agree and a touched-but-unchanged file still revalidates. */
    etag: '"' + createHash("sha256").update(body).digest("base64url").slice(0, 27) + '"',
    csp: type.startsWith("text/html") ? pagePolicy(body) : null,
    compressible: COMPRESSIBLE_TYPE.test(type) && body.byteLength >= COMPRESS_MIN_BYTES,
    encoded: new Map()
  };
  assetCache.set(filePath, entry);
  return entry;
}

/**
 * The asset's body in one encoding, compressing and caching on first request.
 *
 * Concurrent requests for the same encoding share one compression: the promise
 * is stored in the map before it settles. A compression failure is not fatal —
 * the caller falls back to the identity encoding.
 *
 * @param {object} entry A cache entry from loadAsset.
 * @param {"br"|"gzip"} encoding
 * @returns {Promise<Buffer|null>} The compressed body, or null to send as-is.
 */
function encodedBody(entry, encoding) {
  const existing = entry.encoded.get(encoding);
  if (existing) return existing;
  const work = (encoding === "br"
    ? compressBrotli(entry.body, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_MAX_QUALITY,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: entry.body.byteLength
        }
      })
    : compressGzip(entry.body, { level: 9 })
  ).then(
    /* Keep the compressed copy only when it actually saved something. */
    (out) => (out.byteLength < entry.body.byteLength ? out : null),
    () => null
  );
  entry.encoded.set(encoding, work);
  return work;
}

/**
 * Answer a conditional request when the client's copy is current.
 *
 * `If-None-Match` wins over `If-Modified-Since` per RFC 9110, and the ETag
 * comparison is weak — it ignores a `W/` prefix — because that is what a
 * cache-revalidation comparison calls for.
 *
 * @returns {boolean} True when a 304 was sent and the caller should stop.
 */
function sentNotModified(request, response, entry, headers) {
  const inm = request.headers["if-none-match"];
  let fresh = false;
  if (inm) {
    /* Stripped from our own tag too: the streamed path's tags are weak. */
    const current = entry.etag.replace(/^W\//, "");
    fresh = inm.split(",").some((tag) => {
      const value = tag.trim();
      return value === "*" || value.replace(/^W\//, "") === current;
    });
  } else if (request.headers["if-modified-since"]) {
    const since = Date.parse(request.headers["if-modified-since"]);
    /* Compare at second resolution: HTTP dates carry no milliseconds, so a
       file's own mtime is routinely a fraction newer than the date we sent. */
    fresh = Number.isFinite(since) && Math.floor(entry.modified / 1000) * 1000 <= since;
  }
  if (!fresh) return false;
  response.statusCode = 304;
  setHeaders(response, headers);
  response.end();
  return true;
}

/**
 * Serve one published file.
 *
 * Files up to COMPRESS_MAX_BYTES are served from the in-memory cache, and the
 * text-like ones among them are compressed. Larger files are streamed straight
 * from disk, still with a validator so repeat requests cost nothing but headers.
 */
async function serveStatic(request, response, url) {
  const page = PAGES.get(url.pathname);
  const candidate = page ? resolve(PROJECT_ROOT, page) : requestedStaticPath(url);
  if (!candidate) return notFound(response, request.method);

  let filePath;
  let fileStat;
  try {
    /* Resolve symlinks before trusting the path, then re-run both the
       containment and the publication test against what it really points at. */
    filePath = await realpath(candidate);
    if (!isInsideProject(filePath)) return notFound(response, request.method);
    if (hasBlockedSegment(relative(REAL_PROJECT_ROOT, filePath).split(sep))) return notFound(response, request.method);
    fileStat = await stat(filePath);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES")) {
      return notFound(response, request.method);
    }
    throw error;
  }

  if (!fileStat.isFile()) return notFound(response, request.method);

  /* Streamed path: files too big to hold in memory. No body is kept, and the
     validator comes from the file's metadata. */
  if (fileStat.size > COMPRESS_MAX_BYTES) {
    const type = contentType(filePath);
    const weak = { etag: 'W/"' + fileStat.size.toString(16) + "-" + Math.floor(fileStat.mtimeMs).toString(16) + '"', modified: fileStat.mtimeMs };
    const validators = {
      "Cache-Control": "no-cache",
      ETag: weak.etag,
      "Last-Modified": fileStat.mtime.toUTCString()
    };
    if (sentNotModified(request, response, weak, validators)) return;

    response.statusCode = 200;
    setHeaders(response, {
      ...validators,
      "Content-Length": fileStat.size,
      "Content-Type": type,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
    if (request.method === "HEAD") return response.end();

    const stream = createReadStream(filePath);
    stream.on("error", (error) => {
      if (!response.headersSent) sendText(response, 500, "internal server error\n");
      else response.destroy(error);
    });
    stream.pipe(response);
    response.on("close", () => stream.destroy());
    return;
  }

  const entry = await loadAsset(filePath, fileStat);
  const headers = {
    "Cache-Control": "no-cache",
    ETag: entry.etag,
    "Last-Modified": entry.lastModified
  };
  if (entry.csp) headers["Content-Security-Policy"] = entry.csp;
  /* Any response whose body depends on the request's Accept-Encoding must say
     so, or a shared cache will hand a brotli body to a client that cannot read
     it. Sent on every compressible asset, including the uncompressed answer. */
  if (entry.compressible) headers.Vary = "Accept-Encoding";
  if (sentNotModified(request, response, entry, headers)) return;

  let body = entry.body;
  if (entry.compressible) {
    const encoding = negotiateEncoding(request.headers["accept-encoding"]);
    if (encoding) {
      const compressed = await encodedBody(entry, encoding);
      if (compressed) {
        body = compressed;
        headers["Content-Encoding"] = encoding;
      }
    }
  }

  return sendBuffer(response, 200, entry.type, body, request.method, headers);
}

/**
 * Route one request. Order matters: liveness, then the API modules, then the
 * method gate, then static files — the gate sits after the APIs because share
 * uses POST and the static tree does not.
 */
async function route(request, response, apis) {
  let url;
  try { url = new URL(request.url || "/", "http://127.0.0.1"); }
  catch (error) { return sendText(response, 400, "bad request\n", request.method); }

  if (url.pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
    return sendBuffer(response, 200, "application/json", Buffer.from('{"status":"ok"}\n'), request.method);
  }
  for (const api of apis) {
    if (url.pathname.startsWith(api.prefix)) return api.service.handle(request, response, url);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendText(response, 405, "method not allowed\n", request.method, { Allow: "GET, HEAD" });
  }
  const canonical = canonicalPath(url.pathname);
  if (canonical) {
    return sendText(response, 301, "moved to " + canonical + "\n", request.method, { Location: canonical + url.search });
  }
  return serveStatic(request, response, url);
}

/**
 * Build the server without starting it, so tests can bind an ephemeral port and
 * pass share options.
 *
 * The timeouts are deliberate: a client that opens a connection and sends
 * nothing must not hold a slot, and the header count and size caps bound what a
 * single request can make the process allocate.
 *
 * @param {object} [options] Passed to every API module's factory.
 * @param {object} [options.shareOptions] Passed to createShareService.
 * @returns {{server: import("node:http").Server, close: () => Promise<void>}}
 */
export function createEyesServer(options = {}) {
  /* One instance of each API module in `api-modules.mjs`, built once per
     server and closed with it. */
  const apis = API_MODULES.map((module) => ({ prefix: module.prefix, service: module.create(options) }));
  const server = createServer({ headersTimeout: 15000, requestTimeout: 30000, maxHeaderSize: 16384 }, (request, response) => {
    securityHeaders(response);
    route(request, response, apis).catch((error) => {
      /* Log the class of failure, never the message: it can contain a path or
         a header the visitor supplied. */
      console.error("request failed:", error.code || error.name);
      if (!response.headersSent) sendText(response, 500, "internal server error\n", request.method);
      else response.destroy();
    });
  });
  server.maxHeadersCount = 100;
  const closeApis = () => apis.forEach((api) => api.service.close());
  server.on("close", closeApis);
  return { server, close() {
    /* Shut down in order: end the event streams so peers learn immediately,
       stop accepting, let in-flight requests drain, and only then force the
       remaining sockets closed. */
    closeApis();
    return new Promise(resolve => {
      const deadline = setTimeout(() => server.closeAllConnections(), 10000);
      deadline.unref();
      server.close(() => { clearTimeout(deadline); resolve(); });
    });
  } };
}

/**
 * Whether this module is the script Node was asked to run.
 *
 * Node resolves symlinks when it loads the entry module, so `import.meta.url`
 * names the real file while `process.argv[1]` keeps the path as typed. The
 * self-hosting layout runs the server through a `current` release symlink, so
 * the two must be compared after resolving both, or the process exits without
 * ever listening.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

/* Run directly — `node dev-server.mjs [port]` — rather than imported by a test
   or by the service wrapper. */
if (isEntryPoint()) {
  const port = parsePort(process.argv[2] ?? process.env.PORT);
  const app = createEyesServer();
  app.server.on("error", (error) => {
    console.error(`server error: ${error.message}`);
    process.exitCode = 1;
  });
  app.server.listen(port, HOST, () => console.log(`𓁹𓁹 running at http://${HOST}:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.close());
}
