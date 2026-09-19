/* 𓁹𓁹 — static checks.
 *
 * The site has no build step, so nothing compiles the pages and nothing would
 * otherwise notice a typo in an inline script until a visitor hit it. These are
 * the checks a bundler would have given us for free, run over the files as they
 * ship. Everything here is fast and has no dependencies; `npm test` covers
 * behaviour, and `npm run test:browser` covers the pages in a real browser.
 *
 * What it verifies, for `index.html`, `404.html` and every page in `t/`:
 *
 *   Inline scripts parse. Each one is compiled with `new Script`, which raises
 *   on a syntax error without executing anything. This matters more than usual
 *   here: the server derives each page's content security policy from the exact
 *   bytes of its inline scripts, so a page that does not parse is one that also
 *   cannot be served safely.
 *
 *   Element IDs are unique. `E.qs` returns the first match, so a duplicate id
 *   silently wires a control to the wrong element rather than failing.
 *
 *   Local assets resolve. Every `src`/`href` that is not remote, a data URI or a
 *   fragment must exist on disk at the path the page asks for. A tool page that
 *   references `../s.js` incorrectly still renders — it just stops working.
 *
 * And for every JavaScript file outside the vendored builds — the root modules,
 * the two subdomain adapters, these scripts and the tests: that Node itself can
 * parse it, via `node --check`. The adapters run only on their hosting platform,
 * so nothing else here would load them.
 *
 * Finally, that the generated static-host files are current: `_redirects` and
 * `vercel.json` list exactly the pages in `t/`, and `.vercelignore` and
 * `_routes.json` hide exactly the files `public-files.mjs` does not publish. A
 * stale one would 404 a page, or publish a private file, on those hosts while
 * everything works locally.
 */

import { readFile, readdir } from 'node:fs/promises';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageSlugs, pagesRedirects, pagesRoutes, privateEntries, vercelConfig, vercelIgnore } from './static-routes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rootFiles = await readdir(root);
/* Discovered, not listed: a new tool page is checked the moment it exists. */
const pages = ['index.html', '404.html', ...(await readdir(resolve(root, 't'))).filter(f => f.endsWith('.html')).map(f => 't/' + f)];
let scripts = 0;
for (const file of pages) {
  const html = await readFile(resolve(root, file), 'utf8');

  const ids = [...html.matchAll(/\bid="([^"\s]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size, `${file}: duplicate element ID`);

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/.test(match[1])) continue;   /* external: nothing inline to parse */
    new Script(match[2], { filename: file }); scripts++;
  }

  for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"?#]+)(?:[?#][^"]*)?"/gi)) {
    if (/^(?:https?:|data:|#)/.test(match[1])) continue;
    const asset = match[1].startsWith('/') ? resolve(root, '.' + match[1]) : resolve(root, dirname(file), match[1]);
    await readFile(asset);   /* throws, with the path, if it is not there */
  }
}
const sources = [
  ...rootFiles.filter(f => /\.m?js$/.test(f)),
  ...(await Promise.all(['api', 'functions', 'functions/api', 'scripts', 'tests'].map(async dir =>
    (await readdir(resolve(root, dir))).filter(f => /\.m?js$/.test(f)).map(f => dir + '/' + f)))).flat()
];
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
const slugs = await pageSlugs();
assert.equal(await readFile(resolve(root, '_redirects'), 'utf8'), pagesRedirects(slugs), '_redirects is out of date; run node scripts/static-routes.mjs');
assert.equal(await readFile(resolve(root, 'vercel.json'), 'utf8'), vercelConfig(slugs), 'vercel.json is out of date; run node scripts/static-routes.mjs');
const entries = privateEntries();
assert.equal(await readFile(resolve(root, '.vercelignore'), 'utf8'), vercelIgnore(entries), '.vercelignore is out of date; run node scripts/static-routes.mjs');
assert.equal(await readFile(resolve(root, '_routes.json'), 'utf8'), pagesRoutes(entries), '_routes.json is out of date; run node scripts/static-routes.mjs');
console.log(`PASS static-host routes cover all ${slugs.length} pages and hide ${entries.length} private entries`);
console.log(`PASS ${pages.length} HTML pages: inline script syntax, unique IDs and local assets (${scripts} inline scripts)`);
console.log(`PASS ${sources.length} JavaScript files parse`);
