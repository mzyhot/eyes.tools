/* Same-origin crt.name proxy — Cloudflare Pages Function.
 *
 * All behaviour lives in `subdomains-core.mjs`; this file only adapts it to the
 * Workers runtime, and must stay interchangeable with the Node / Vercel adapter
 * in `api/subdomains.js`.
 *
 * The one thing it adds is the edge cache. A Worker isolate is short-lived and
 * may not be reused, so an in-process cache would rarely hit; `caches.default`
 * is shared across isolates in a colo and does the same job better. Requests
 * are normalized to a canonical key first, so `?apex=BÜCHER.de`,
 * `?apex=*.xn--bcher-kva.de` and `?apex=xn--bcher-kva.de&t=1` are one cache
 * entry rather than three — and a visitor cannot dilute the cache by appending
 * junk parameters.
 *
 * How long an entry survives is `Cache-Control` from the core, which is the
 * same header the browser and any CDN in front of this see.
 */

import {
  createSubdomainLookup,
  lookupSubdomains,
  methodNotAllowed,
  normalizeApex,
  responseHeaders
} from "../../subdomains-core.mjs";

/* Coalescing, for the case the edge cache does not cover: several requests for
   the same domain arriving in one isolate before any of them has an answer.
   The isolate may be discarded at any point, which is fine — this is an
   optimization, never the correctness boundary. */
const lookup = createSubdomainLookup({ lookup: lookupSubdomains });

/** Turn a core outcome into a Response. */
function jsonResponse(result) {
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: responseHeaders(result.status, result.headers)
  });
}

/**
 * The cache key for a lookup: this path, the normalized apex, nothing else.
 * @param {Request} request The incoming request, for its origin.
 * @param {string} apex Already normalized.
 * @returns {Request}
 */
function canonicalCacheKey(request, apex) {
  var url = new URL(request.url);
  url.pathname = "/api/subdomains";
  url.search = "";
  url.hash = "";
  url.searchParams.set("apex", apex);
  return new Request(url.toString(), { method: "GET" });
}

export async function onRequestGet(context) {
  var requestUrl = new URL(context.request.url);
  var apex;
  /* Normalize before touching the cache: an invalid domain must never occupy an
     entry, and two spellings of a valid one must share theirs. */
  try { apex = normalizeApex(requestUrl.searchParams.get("apex")); }
  catch (error) { return jsonResponse({ status: 400, body: { error: "invalid apex domain" }, headers: {} }); }

  var cache = typeof caches !== "undefined" ? caches.default : null;
  var cacheKey = canonicalCacheKey(context.request, apex);
  if (cache) {
    /* A cache that is unavailable or throwing is not a reason to fail the
       request; fall through to the upstream. */
    try {
      var cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch (error) {}
  }

  var result = await lookup(apex);
  var response = jsonResponse(result);
  /* Only successes are stored, and the write is handed to waitUntil so the
     visitor is not kept waiting for it. */
  if (cache && result.status === 200) {
    context.waitUntil(cache.put(cacheKey, response.clone()).catch(function () {}));
  }
  return response;
}

/* Anything that is not a GET. Pages routes the specific verb handler first, so
   this is only reached by the others. */
export function onRequest() {
  return jsonResponse(methodNotAllowed());
}
