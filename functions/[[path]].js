/* Private paths on Cloudflare Pages.
 *
 * Pages publishes every file in the project, where the Node server publishes
 * only what `public-files.mjs` names. `_routes.json`, written by
 * `scripts/static-routes.mjs`, sends requests for everything else here, and
 * this answers them the way the Node server does: the 404 page, status 404.
 * `/api/subdomains` has its own, more specific function and never reaches it.
 */
export async function onRequest(context) {
  const page = await context.env.ASSETS.fetch(new URL("/404", context.request.url));
  return new Response(page.body, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}
