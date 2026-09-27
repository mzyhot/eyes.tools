/* Private paths on Cloudflare Pages.
 *
 * Pages publishes every file in the project, where the Node server publishes
 * only what `public-files.mjs` names. `_routes.json`, written by
 * `scripts/static-routes.mjs`, sends requests for everything else here, and
 * this answers them the way the Node server does: the 404 page, status 404.
 *
 * Pages does not apply `_headers` to a Function's own response, so the 404
 * keeps the headers the page itself was served with, security headers
 * included, and changes only what makes it a 404.
 */
export async function onRequest(context) {
  const page = await context.env.ASSETS.fetch(new URL("/404", context.request.url));
  if (!page.ok) {
    return new Response("not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    });
  }
  const headers = new Headers(page.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.delete("ETag");
  headers.delete("Last-Modified");
  return new Response(page.body, { status: 404, headers });
}
