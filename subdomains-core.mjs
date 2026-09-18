/* 𓁹𓁹 — shared crt.name lookup core.
 *
 * The subdomain tool cannot call crt.name directly: the response is plain text
 * with no CORS headers, and a browser-side call would leak the visitor's IP to
 * a third party. Every deployment therefore proxies it, and this module is the
 * proxy's whole behaviour — validation, bounded streaming, normalization and
 * response headers — with no dependency on any host platform.
 *
 * Three adapters share it and must stay interchangeable:
 *   `dev-server.mjs`            the Node server (also the self-hosting target)
 *   `api/subdomains.js`         Node / Vercel serverless
 *   `functions/api/subdomains.js`  Cloudflare Pages Functions
 *
 * Two properties matter more than speed and constrain the code below.
 *
 * Scope. Certificate transparency logs contain whatever a certificate claimed,
 * including names belonging to other people. Every row is re-normalized here
 * and discarded unless it is the queried apex or sits under it, so the proxy
 * cannot be used to launder an arbitrary hostname through this origin.
 *
 * Bounds. The upstream response is unbounded in principle. It is read as a
 * stream and cut off at `maxBytes` and `maxResults`, and the request is aborted
 * after `timeoutMs`, so one lookup cannot exhaust a shared serverless instance.
 * A cut-off answer is still returned, flagged `truncated`.
 */

/** Hard ceiling on bytes read from crt.name, whatever it claims to be sending. */
export const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
/** Hard ceiling on distinct hostnames returned to the browser. */
export const MAX_RESULTS = 10000;
/** How long a single upstream request may take before it is aborted. */
export const REQUEST_TIMEOUT_MS = 10000;
/* Certificate transparency data is append-only and slow-moving, so a
   successful answer is worth caching hard at every layer in front of us. */
export const SUCCESS_CACHE_CONTROL = "public, max-age=300, s-maxage=21600, stale-while-revalidate=86400";

/**
 * A platform-neutral response: the adapters translate it into whatever their
 * runtime expects.
 * @param {number} status HTTP status.
 * @param {object} body JSON body.
 * @param {Object<string,string>} [headers] Extra headers to merge in.
 */
function outcome(status, body, headers) {
  return { status: status, body: body, headers: headers || {} };
}

/* Built once. Every response gets the same base set, so it is spread rather
   than rebuilt per request. */
const BASE_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Content-Type": "application/json; charset=utf-8",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff"
};

/**
 * Headers for a proxy response. JSON is served with a null CSP and same-origin
 * resource policy so a hostile page cannot embed or read it cross-site.
 * @param {number} status The status being sent.
 * @param {Object<string,string>} [extra] Adapter-supplied additions.
 * @returns {Object<string,string>}
 */
export function responseHeaders(status, extra) {
  const headers = {
    "Cache-Control": status === 200 ? SUCCESS_CACHE_CONTROL : "no-store",
    ...BASE_HEADERS
  };
  if (status === 405) headers.Allow = "GET";
  if (extra) for (const key of Object.keys(extra)) headers[key] = extra[key];
  return headers;
}

/** The single response for any verb other than GET. */
export function methodNotAllowed() {
  return outcome(405, { error: "method not allowed" });
}

function invalidApex() {
  const error = new TypeError("invalid apex domain");
  error.code = "INVALID_APEX";
  return error;
}

/* A hostname may contain non-ASCII (it becomes punycode below), but every ASCII
   character in it must be one DNS allows. Written as one regex rather than a
   per-code-point loop because it runs on every line of the upstream stream.
   The `u` flag makes `[^\x00-\x7f]` match a whole code point. */
const SAFE_HOST_CHARS = /^(?:[a-z0-9.-]|[^\x00-\x7f])*$/u;

/* A hostname already in DNS-ready ASCII form. */
const PLAIN_HOST = /^[a-z0-9.-]+$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/* Public DNS currently has no all-numeric or one-character TLDs. */
const DNS_TLD = /^[a-z]{2,63}$/;
const PUNYCODE_TLD = /^xn--[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/;

/**
 * Whether a string is a hostname this proxy is willing to speak about: at least
 * two labels, each a valid DNS label, a plausible public TLD, no trailing dot.
 * Deliberately stricter than the URL parser — it rejects `localhost`, bare IPs
 * and single-label names, none of which have subdomains worth looking up.
 * @param {string} hostname Already lowercase ASCII.
 * @returns {boolean}
 */
function validDnsHostname(hostname) {
  if (typeof hostname !== "string" || !hostname || hostname.length > 253 || hostname.endsWith(".")) return false;
  const labels = hostname.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!label || label.length > 63 || !DNS_LABEL.test(label)) return false;
  }
  const tld = labels[labels.length - 1];
  return DNS_TLD.test(tld) || PUNYCODE_TLD.test(tld);
}

/**
 * Reduce any accepted spelling of a hostname to one canonical ASCII form:
 * trimmed, lowercased, wildcard prefix removed, IDN converted to punycode.
 *
 * The URL parser does the IDN work, but constructing a URL is by far the most
 * expensive step here and it runs once per line of a response that may hold
 * hundreds of thousands of them. A hostname that is already lowercase ASCII,
 * already valid, and free of `xn--` labels cannot be altered by that parser, so
 * it is returned directly. Anything else — non-ASCII, existing punycode, or
 * malformed — still goes through the parser, which owns the hard cases.
 *
 * @param {string} value Raw hostname.
 * @returns {string} Canonical hostname.
 * @throws {TypeError} With code `INVALID_APEX` if it is not usable.
 */
function normalizeHostname(value) {
  if (typeof value !== "string") throw invalidApex();
  let raw = value.trim().toLowerCase();
  /* Strip a wildcard prefix. A character test rather than a regex: this runs
     once per line of the upstream stream. */
  if (raw.charCodeAt(0) === 42 && raw.charCodeAt(1) === 46) raw = raw.slice(2);
  if (!raw || raw.length > 1024 || !SAFE_HOST_CHARS.test(raw)) throw invalidApex();
  if (PLAIN_HOST.test(raw) && !raw.includes("xn--") && validDnsHostname(raw)) return raw;
  let hostname;
  try { hostname = new URL("https://" + raw + "/").hostname.toLowerCase(); }
  catch (error) { throw invalidApex(); }
  if (!validDnsHostname(hostname)) throw invalidApex();
  return hostname;
}

/**
 * Normalize the apex the visitor asked about. The only entry point adapters
 * need for validation.
 * @param {string} value Raw query value.
 * @returns {string} Canonical apex.
 * @throws {TypeError} If it is not a usable apex domain.
 */
export function normalizeApex(value) {
  return normalizeHostname(value);
}

/**
 * Normalize one upstream row and confirm it is in scope.
 * @param {string} value Raw hostname from crt.name.
 * @param {string} apex The canonical apex being queried.
 * @returns {string} The hostname, or "" if it is malformed or out of scope.
 */
function normalizeResult(value, apex) {
  let hostname;
  try { hostname = normalizeHostname(value); }
  catch (error) { return ""; }
  return hostname === apex || hostname.endsWith("." + apex) ? hostname : "";
}

/* crt.name emits a plain date; accept a full timestamp too, and verify the date
   actually exists — the upstream has been seen emitting 2024-02-31. */
const DATE_SHAPE = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Validate a calendar date by arithmetic rather than by round-tripping it
 * through Date: a `Date` allocation and an ISO format per line is the single
 * most expensive thing this parser could do per row, and the rule is four lines.
 * @param {*} value Raw date field.
 * @returns {string} `YYYY-MM-DD`, or "" when absent or impossible.
 */
function normalizeDate(value) {
  const match = DATE_SHAPE.exec(String(value || ""));
  if (!match) return "";
  const date = match[1];
  const year = +date.slice(0, 4), month = +date.slice(5, 7), day = +date.slice(8, 10);
  if (month < 1 || month > 12 || day < 1) return "";
  const leap = month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return day <= MONTH_LENGTHS[month - 1] + (leap ? 1 : 0) ? date : "";
}

/**
 * Fold one `hostname\tdate` line into the accumulator, keeping the earliest
 * date seen for a hostname — the same name appears once per certificate.
 * @param {string} line One upstream line, newline already stripped.
 * @param {string} apex Canonical apex, for the scope test.
 * @param {Map<string,string>} byName Accumulator: hostname → first seen date.
 * @returns {boolean} True when this line introduced a new hostname.
 */
function addLine(line, apex, byName) {
  if (!line) return false;
  const tab = line.indexOf("\t");
  const sub = normalizeResult(tab < 0 ? line : line.slice(0, tab), apex);
  if (!sub) return false;
  const seen = normalizeDate(tab < 0 ? "" : line.slice(tab + 1));
  const prior = byName.get(sub);
  if (prior === undefined || (seen && (!prior || seen < prior))) byName.set(sub, seen);
  return prior === undefined;
}

/**
 * Read the upstream body as a stream, parsing complete lines as they arrive and
 * stopping at the first limit reached.
 *
 * Partial lines are held in `pending`. That buffer is scanned with a moving
 * offset and sliced once per chunk rather than once per line: re-slicing per
 * line makes parsing quadratic in the buffer size, which is what a multi-
 * megabyte response actually costs.
 *
 * @param {Response} upstream A fetch Response with a readable body.
 * @param {string} apex Canonical apex.
 * @param {number} maxBytes Byte ceiling.
 * @param {number} maxResults Hostname ceiling.
 * @returns {Promise<{results: Array<{sub: string, first_seen: string}>, truncated: boolean}>}
 */
async function readResults(upstream, apex, maxBytes, maxResults) {
  if (!upstream.body || typeof upstream.body.getReader !== "function") throw new Error("missing response body");
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const byName = new Map();
  let pending = "";
  let bytes = 0;
  let truncated = false;
  let stop = false;

  try {
    while (!stop) {
      const part = await reader.read();
      if (part.done) break;
      let chunk = part.value;
      const remaining = maxBytes - bytes;
      if (remaining <= 0) { truncated = true; break; }
      if (chunk.byteLength > remaining) {
        /* Keep the bytes that fit and stop after parsing them: a partial answer
           is more useful than none, as long as it says it is partial. */
        chunk = chunk.subarray(0, remaining);
        truncated = true;
        stop = true;
      }
      bytes += chunk.byteLength;
      pending += decoder.decode(chunk, { stream: true });

      let from = 0, newline;
      while ((newline = pending.indexOf("\n", from)) > -1) {
        let end = newline;
        if (end > from && pending.charCodeAt(end - 1) === 13) end--;   /* CR of a CRLF */
        const line = pending.slice(from, end);
        from = newline + 1;
        if (addLine(line, apex, byName) && byName.size > maxResults) {
          truncated = true;
          stop = true;
          break;
        }
      }
      if (from) pending = pending.slice(from);
    }

    /* A final line with no newline after it, plus whatever the decoder was
       holding for an incomplete multi-byte sequence. Skipped when truncated:
       the tail is then a fragment of a line we deliberately cut. */
    if (!truncated) {
      pending += decoder.decode();
      if (pending.endsWith("\r")) pending = pending.slice(0, -1);
      if (pending && addLine(pending, apex, byName) && byName.size > maxResults) truncated = true;
    }
  } finally {
    /* Release the socket even when parsing threw or stopped early, so an
       abandoned upstream response cannot hold a connection open. */
    try { await reader.cancel(); } catch (error) {}
    reader.releaseLock();
  }

  const results = Array.from(byName, (entry) => ({ sub: entry[0], first_seen: entry[1] }));
  results.sort((a, b) => (a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0));
  if (results.length > maxResults) results.length = maxResults;
  return { results, truncated };
}

/**
 * Perform one upstream lookup, end to end.
 *
 * Every failure mode collapses into a small set of statuses with messages fit
 * to show a visitor; upstream detail is never forwarded. A 429 from crt.name
 * becomes a 503 here, because their rate limit is our capacity problem, not the
 * visitor's mistake.
 *
 * @param {string} rawApex The requested domain, unvalidated.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] Injected for tests.
 * @param {number} [options.maxBytes]
 * @param {number} [options.maxResults]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{status: number, body: object, headers: Object<string,string>}>}
 */
export async function lookupSubdomains(rawApex, options) {
  options = options || {};
  let apex;
  try { apex = normalizeApex(rawApex); }
  catch (error) { return outcome(400, { error: "invalid apex domain" }); }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return outcome(502, { error: "subdomain service is unavailable" });
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_UPSTREAM_BYTES;
  const maxResults = Number.isSafeInteger(options.maxResults) && options.maxResults > 0 ? options.maxResults : MAX_RESULTS;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = new URL("https://crt.name/v1/search");
    url.searchParams.set("apex", apex);
    url.searchParams.set("dates", "1");
    const upstream = await fetchImpl(url, { headers: { Accept: "text/plain" }, signal: controller.signal });
    const type = String(upstream.headers.get("content-type") || "").toLowerCase();
    /* Anything we will not parse gets its body cancelled rather than left to be
       garbage collected, which would keep the connection open. */
    if (!upstream.ok || !type.startsWith("text/plain")) {
      try { await upstream.body?.cancel(); } catch (error) {}
    }
    if (upstream.status === 400) return outcome(400, { error: "invalid apex domain" });
    if (upstream.status === 429) return outcome(503, { error: "subdomain service is temporarily unavailable" });
    if (!upstream.ok) return outcome(502, { error: "subdomain service is unavailable" });
    /* An HTML body here means a captive portal or a bot challenge, not data. */
    if (!type.startsWith("text/plain")) return outcome(502, { error: "subdomain service returned an invalid response" });

    const parsed = await readResults(upstream, apex, maxBytes, maxResults);
    return outcome(200, {
      apex: apex,
      count: parsed.results.length,
      results: parsed.results,
      truncated: parsed.truncated
    });
  } catch (error) {
    const timedOut = error && error.name === "AbortError";
    return outcome(timedOut ? 504 : 502, {
      error: timedOut ? "subdomain lookup timed out" : "subdomain service is unavailable"
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wrap a lookup with the coalescing and caching a long-lived server needs.
 *
 * Three separate protections, because a single popular domain, a burst of
 * distinct domains, and a slow upstream each fail differently:
 *   · identical concurrent lookups share one in-flight request, so a page
 *     refreshed ten times costs one upstream call;
 *   · successful answers are cached for `ttlMs`, capped at `maxEntries` and
 *     evicted oldest-first, which bounds memory regardless of traffic;
 *   · more than `maxConcurrent` distinct lookups in flight is refused with a
 *     503 and a Retry-After rather than queued, so the server never accumulates
 *     an unbounded backlog of upstream requests.
 *
 * Failures are never cached — the next visitor should get a real attempt.
 *
 * @param {object} [options]
 * @param {(apex: string) => Promise<object>} [options.lookup] Injected for tests.
 * @param {() => number} [options.now] Clock, injected for tests.
 * @param {number} [options.maxConcurrent]
 * @param {number} [options.maxEntries]
 * @param {number} [options.ttlMs]
 * @returns {(rawApex: string) => Promise<object>}
 */
export function createSubdomainLookup({ lookup = lookupSubdomains, now = Date.now, maxConcurrent = 8, maxEntries = 32, ttlMs = 300000 } = {}) {
  const cache = new Map(), pending = new Map();
  return async function (rawApex) {
    let apex;
    try { apex = normalizeApex(rawApex); }
    catch { return outcome(400, { error: "invalid apex domain" }); }
    const hit = cache.get(apex);
    if (hit && hit.expires > now()) return hit.result;
    cache.delete(apex);
    if (pending.has(apex)) return pending.get(apex);
    if (pending.size >= maxConcurrent) return outcome(503, { error: "subdomain service is busy; try again shortly" }, { "Retry-After": "10" });
    const request = Promise.resolve().then(() => lookup(apex)).then(result => {
      if (result.status === 200) {
        /* Map iteration is insertion-ordered, so the first key is the oldest. */
        if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
        cache.set(apex, { result, expires: now() + ttlMs });
      }
      return result;
    }).finally(() => pending.delete(apex));
    pending.set(apex, request);
    return request;
  };
}
