/* Same-origin crt.name proxy — Node / Vercel adapter.
 *
 * All behaviour lives in `subdomains-core.mjs`; this file only translates
 * between that module and the Node-style `(req, res)` signature Vercel invokes,
 * and it must stay interchangeable with the Cloudflare Pages Function in
 * `functions/api/subdomains.js`.
 *
 * CommonJS, because the platform loads this file directly and the core is ESM:
 * the dynamic import is started at module scope so it is already resolved by
 * the time the first request arrives, rather than awaited cold per request.
 *
 * Serverless instances are reused across requests, so the coalescing cache is
 * worth building here too — a warm instance answers a repeated lookup from
 * memory, and identical concurrent lookups share a single upstream call
 * instead of each making their own.
 */

var corePromise = import("../subdomains-core.mjs").then(function (core) {
  return { core: core, lookup: core.createSubdomainLookup() };
});

/**
 * Read the `apex` query value, whichever way the platform presents it.
 * Vercel parses the query for us; a plain Node host does not.
 * @param {import("node:http").IncomingMessage & {query?: object}} req
 * @returns {string|null}
 */
function queryValue(req) {
  if (req.query && Object.prototype.hasOwnProperty.call(req.query, "apex")) return req.query.apex;
  try { return new URL(req.url, "http://localhost").searchParams.get("apex"); }
  catch (error) { return null; }
}

/**
 * Write one core outcome as an HTTP response, using whichever status API the
 * host provides.
 */
function send(res, core, result) {
  var headers = core.responseHeaders(result.status, result.headers);
  Object.keys(headers).forEach(function (name) { res.setHeader(name, headers[name]); });
  if (typeof res.status === "function") res.status(result.status);
  else res.statusCode = result.status;
  return res.end(JSON.stringify(result.body));
}

module.exports = async function handler(req, res) {
  var ready = await corePromise;
  if (req.method && req.method !== "GET") return send(res, ready.core, ready.core.methodNotAllowed());
  return send(res, ready.core, await ready.lookup(queryValue(req)));
};
