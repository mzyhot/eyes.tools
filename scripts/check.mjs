/* 𓁹𓁹: static checks.
 *
 * The site has no build step, so nothing compiles the pages and nothing would
 * otherwise notice a typo in an inline script until a visitor hit it. These are
 * the checks a bundler would have given us for free, run over the files as they
 * ship. Everything here is fast and has no dependencies; `npm test` covers
 * behaviour, and `npm run test:browser` covers the pages in a real browser.
 *
 * It also verifies the shape every page shares, because the shared layer only
 * works if pages stay out of its way: a page owns its `<main>` and one script,
 * the registry owns its title, header, lede, footer note and dependencies, and
 * `site.js` owns everything else. A page that writes its own header, or names a
 * script the registry should name, fails here.
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
 *   references `../s.js` incorrectly still renders; it just stops working.
 *
 * And for every JavaScript file (the root modules and vendored builds, the
 * Pages function, these scripts and the tests): that Node itself can parse it,
 * via `node --check`. The Pages function runs only on its hosting platform, so
 * nothing else here would load it.
 *
 * Finally, that the generated static-host files are current: `_redirects` and
 * `vercel.json` list exactly the pages in `t/`, `vercel.json` and `_headers`
 * carry the server's security headers, and `.vercelignore` and `_routes.json`
 * hide exactly the files `public-files.mjs` does not publish. A stale one would
 * 404 a page, drop a header, or publish a private file on those hosts while
 * everything works locally. And that `sitemap.xml` names the index and every
 * tool in the registry, so search engines hear of a new tool, that every font
 * file `fonts.css` names exists and is published, and that the desktop app's
 * content security policy still mirrors the server's.
 */

import { readFile, readdir } from 'node:fs/promises';
import { Script } from 'node:vm';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_ROOT_FILES } from '../public-files.mjs';
import { CSP, readRegistries } from '../dev-server.mjs';
import { pageSlugs, pagesHeaders, pagesRedirects, pagesRoutes, privateEntries, sitemap, vercelConfig, vercelIgnore } from './static-routes.mjs';

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
  ...(await Promise.all(['functions', 'scripts', 'tests'].map(async dir =>
    (await readdir(resolve(root, dir))).filter(f => /\.m?js$/.test(f)).map(f => dir + '/' + f)))).flat()
];
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
/* The registry and `t/` must agree, and a page must keep to the shared shape. */
const { site, tools } = await readRegistries();
const registry = new Map(tools.map(tool => [tool.slug, tool]));
const publicFiles = new Set(PUBLIC_ROOT_FILES);
const pagesInTools = (await readdir(resolve(root, 't'))).filter(f => f.endsWith('.html')).map(f => f.slice(0, -'.html'.length));
for (const slug of registry.keys()) {
  assert.ok(pagesInTools.includes(slug), `tools.js lists ${slug}, but t/${slug}.html does not exist`);
}
for (const slug of pagesInTools) {
  const html = await readFile(resolve(root, 't', slug + '.html'), 'utf8');
  const tool = registry.get(slug);
  if (!tool) {
    assert.match(html, /redirect\.js/, `t/${slug}.html has no row in tools.js and is not a redirect`);
    continue;
  }
  assert.match(html, new RegExp(`<body data-tool="${slug}"`), `t/${slug}.html: data-tool must be "${slug}"`);
  assert.match(html, /E\.tool\(function/, `t/${slug}.html: wrap the tool's script in E.tool(function () { … })`);
  /* The shell is everything outside the tool's own markup and script. */
  const shell = html.replace(/<main\b[\s\S]*?<\/main>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
  for (const chrome of ['<header', '<footer', 'class="wrap"', 'data-crumb', 'data-title', 'data-lede', '<title>', 'name="description"']) {
    assert.ok(!shell.includes(chrome), `t/${slug}.html: ${chrome} comes from site.js and tools.js, not the page`);
  }
  for (const dep of tool.deps || []) {
    assert.ok(publicFiles.has(dep), `tools.js: ${slug} depends on ${dep}, which public-files.mjs does not publish`);
    assert.ok(!html.includes('"../' + dep + '"'), `t/${slug}.html: ${dep} is loaded from the registry's deps, not the page`);
  }
}
console.log(`PASS ${registry.size} registry rows match their pages and the shared page shape`);

const slugs = await pageSlugs();
assert.equal(await readFile(resolve(root, '_redirects'), 'utf8'), pagesRedirects(slugs), '_redirects is out of date; run node scripts/static-routes.mjs');
assert.equal(await readFile(resolve(root, 'vercel.json'), 'utf8'), vercelConfig(slugs), 'vercel.json is out of date; run node scripts/static-routes.mjs');
assert.equal(await readFile(resolve(root, '_headers'), 'utf8'), pagesHeaders(), '_headers is out of date; run node scripts/static-routes.mjs');
const entries = privateEntries();
assert.equal(await readFile(resolve(root, '.vercelignore'), 'utf8'), vercelIgnore(entries), '.vercelignore is out of date; run node scripts/static-routes.mjs');
assert.equal(await readFile(resolve(root, '_routes.json'), 'utf8'), pagesRoutes(entries), '_routes.json is out of date; run node scripts/static-routes.mjs');
console.log(`PASS static-host routes cover all ${slugs.length} pages, send the server's headers, and hide ${entries.length} private entries`);
assert.equal(await readFile(resolve(root, 'sitemap.xml'), 'utf8'), sitemap(site.url, [...registry.keys()]), 'sitemap.xml is out of date; run node scripts/static-routes.mjs');
console.log(`PASS sitemap.xml lists the index and all ${registry.size} tools`);

/* Link previews name the site by its address and show a published picture. */
assert.match(site.url || '', /^https:\/\/[^/]+$/, 'site.js: url must be the https:// origin of the site, with no path or trailing slash');
assert.ok(site.name, 'site.js: name is the plain-text name link previews show');
if (site.preview) {
  assert.ok(publicFiles.has(site.preview.image), `site.js: the preview image ${site.preview.image} must be listed in public-files.mjs`);
  const png = await readFile(resolve(root, site.preview.image));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [site.preview.width, site.preview.height], `site.js: ${site.preview.image} is not ${site.preview.width}×${site.preview.height}`);
}
console.log(`PASS link previews name ${site.url} and show a published ${site.preview ? site.preview.width + '×' + site.preview.height + ' picture' : 'page without a picture'}`);

/* The typeface ships with the site: every file `fonts.css` names is on disk and
   published, or a static host would 404 it while the Node server serves it. */
{
  const css = await readFile(resolve(root, 'fonts.css'), 'utf8');
  const files = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(m => m[1]).filter(url => !url.startsWith('data:'));
  for (const file of files) {
    assert.ok(publicFiles.has(file), `fonts.css: ${file} must be listed in public-files.mjs`);
    await readFile(resolve(root, file)).catch(() => assert.fail(`fonts.css: ${file} does not exist`));
  }
  console.log(`PASS fonts.css names ${files.length} font files, all published`);
}

/* The desktop app's policy mirrors the server's. It may allow more where the
   app needs it (its own IPC, the share service it reaches), never less. */
{
  const directives = csp => new Map(csp.split(';').map(d => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
  const desktop = JSON.parse(await readFile(resolve(root, 'desktop/tauri.conf.json'), 'utf8')).app.security.csp;
  for (const [name, sources] of directives(CSP)) {
    const app = (desktop[name] || '').split(/\s+/);
    assert.deepEqual(app.slice(0, sources.length), sources, `desktop/tauri.conf.json: ${name} must begin with the server's "${sources.join(' ')}"`);
  }
  console.log(`PASS the desktop app's content security policy mirrors the server's`);
}
console.log(`PASS ${pages.length} HTML pages: inline script syntax, unique IDs and local assets (${scripts} inline scripts)`);
console.log(`PASS ${sources.length} JavaScript files parse`);
