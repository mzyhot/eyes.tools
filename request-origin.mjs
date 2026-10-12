/* 𓁹𓁹: which pages may call the server's APIs.
 *
 * Share and the MCP server answer browser requests from this site's own pages,
 * and from the origins an operator lists for each (`SHARE_ALLOWED_ORIGINS`,
 * `MCP_ALLOWED_ORIGINS`), which alone get CORS headers. Both use this one
 * check, so the two can never disagree about what counts as this site.
 */

/**
 * The origin check for one API.
 * @param {string} [allowedOrigins] Comma-separated origins, besides this site's
 *   own, that may call from a browser. Empty or unset allows none.
 * @returns {{allowedCrossOrigin: Function, sameOrigin: Function}}
 */
export function originPolicy(allowedOrigins) {
  /* Fixed for the process; parsed once rather than per request. */
  const crossOrigins = new Set(allowedOrigins ? allowedOrigins.split(",").map(v => v.trim()).filter(Boolean) : []);
  return {
    /** The request's origin if the operator allows it cross-origin, else null. */
    allowedCrossOrigin(request) {
      const origin = request.headers.origin;
      return typeof origin === "string" && crossOrigins.has(origin) ? origin : null;
    },
    sameOrigin
  };
}

/** Whether the request came from this site, or from no browser page at all. */
function sameOrigin(request) {
  const site = request.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === request.headers.host; }
  catch { return false; }
}
