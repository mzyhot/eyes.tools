import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEyesServer, previewTags, readRegistries } from '../dev-server.mjs';

test('production HTTP boundaries, security headers, and graceful shutdown', async t => {
  const app = createEyesServer();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = path => fetch(base + path);
  for (const path of ['/', '/share', '/json', '/s.js', '/site.js', '/fonts.css', '/index.js', '/robots.txt', '/sitemap.xml', '/THIRDPARTYLICENSES', '/LICENSE', '/ADDENDUM']) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    const body = await res.text();
    if (res.headers.get('content-type').includes('text/html')) {
      const policy = res.headers.get('content-security-policy');
      assert.ok(!policy.includes("script-src 'self' 'unsafe-inline'"));
      for (const match of body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
        if (/\bsrc\s*=/.test(match[1])) continue;
        assert.ok(policy.includes(`'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`), path);
      }
    }
  }
  for (const path of ['/dev-server.mjs', '/share-server.mjs', '/mcp-server.mjs', '/public-files.mjs', '/README.md', '/tests/server.test.mjs', '/.git/config', '/.env', '/package.json', '/s.js.bak', '/%2e%2e%2fetc/passwd', '/%ZZ', '/t/%2e%2e%2fshare-server.mjs']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    // The not-found page has no inline script, so the base policy covers it.
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'$/);
    await res.arrayBuffer();
  }
  const robots = await get('/robots.txt');
  assert.match(robots.headers.get('content-type'), /^text\/plain;\s*charset=utf-8$/i);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /^User-agent: \*$/m);
  assert.match(robotsBody, /^Content-Signal: search=yes, ai-input=yes, ai-train=no$/m);
  assert.match(robotsBody, /^Allow: \/$/m);
  assert.match(robotsBody, /^Disallow: \/api\/$/m);
  assert.match(robotsBody, /^Sitemap: https:\/\/eyes\.tools\/sitemap\.xml$/m);
  const sitemap = await get('/sitemap.xml');
  assert.match(sitemap.headers.get('content-type'), /^application\/xml;\s*charset=utf-8$/i);
  assert.match(await sitemap.text(), /<urlset[^>]+sitemaps\.org\/schemas\/sitemap\/0\.9/);
  assert.deepEqual(await (await get('/healthz')).json(), { status: 'ok' });
  // Old and non-canonical addresses redirect permanently, keeping the query.
  for (const [from, to] of [['/t/share.html', '/share'], ['/t/json.html?t=%7B%7D', '/json?t=%7B%7D'], ['/index.html', '/'], ['/share/', '/share'], ['/t/lines.html', '/lines']]) {
    const res = await fetch(base + from, { redirect: 'manual' });
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
    await res.arrayBuffer();
  }
  // Nothing that is not a page is invented: unknown slugs and odd spellings stay 404.
  for (const path of ['/t/nope.html', '/nope', '/nope/', '/share.html', '/t/share', '/T/share.html', '/t/../share-server.mjs']) {
    const res = await fetch(base + path, { redirect: 'manual' });
    assert.equal(res.status, 404, path);
    await res.arrayBuffer();
  }
  const head = await fetch(base + '/share', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.ok(Number(head.headers.get('content-length')) > 0);
  const post = await fetch(base + '/index.html', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  await post.text();
  // Only the share API exists; anything else under /api is a static miss.
  const api = await get('/api/subdomains?apex=example.com');
  assert.equal(api.status, 404);
  await api.arrayBuffer();
  // A coding refused with q=0 is never chosen.
  for (const [offer, expected] of [['br, gzip', 'br'], ['br;q=0, gzip', 'gzip'], ['gzip;q=0', null], ['identity', null]]) {
    const res = await fetch(base + '/s.js', { headers: { 'Accept-Encoding': offer } });
    assert.equal(res.headers.get('content-encoding'), expected, offer);
    await res.arrayBuffer();
  }
});

test('pages carry their link preview in the HTML, before any script runs', async t => {
  const app = createEyesServer();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { site, tools } = await readRegistries();
  const head = async path => { const html = await (await fetch(base + path)).text(); return html.slice(0, html.indexOf('</head>')); };
  const meta = (html, key) => new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)">`).exec(html)?.[1];
  for (const tool of tools) {
    const page = await head('/' + tool.slug);
    assert.equal(page.match(/<title>/g)?.length, 1, tool.slug);
    assert.ok(page.includes(`<title>${tool.name}${site.titleSuffix}</title>`), tool.slug);
    assert.equal(meta(page, 'description'), tool.meta, tool.slug);
    assert.equal(meta(page, 'og:title'), tool.name, tool.slug);
    assert.equal(meta(page, 'og:url'), `${site.url}/${tool.slug}`, tool.slug);
    assert.equal(meta(page, 'og:image'), `${site.url}/${site.preview.image}?${site.preview.stamp}`, tool.slug);
  }
  const index = await head('/');
  assert.equal(meta(index, 'og:title'), site.name);
  assert.equal(meta(index, 'og:description'), site.description);
  assert.equal(meta(index, 'og:url'), site.url + '/');
  // A redirect stub has no row, so no preview.
  assert.ok(!(await head('/lines')).includes('og:'));
  // The picture's address follows its bytes, so a new picture is never mistaken for the old one.
  assert.equal(site.preview.stamp, createHash('sha256').update(await readFile(new URL('../' + site.preview.image, import.meta.url))).digest('hex').slice(0, 8));
  const picture = await fetch(`${base}/${site.preview.image}?${site.preview.stamp}`);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('content-type'), 'image/png');
  assert.equal(picture.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await fetch(base + '/favicon.svg')).headers.get('cross-origin-resource-policy'), 'same-origin');
  await picture.arrayBuffer();
  // What the registries say is text, never markup.
  const tags = previewTags({ ...site, url: 'https://example.test' }, { slug: 'x', name: '</title><script>', meta: '"><b>' });
  assert.ok(!tags.includes('<script') && !tags.includes('<b>'));
  assert.equal(tags.match(/<\/title>/g).length, 1);
  assert.ok(tags.includes('content="&#34;&#62;&#60;b&#62;"'));
});

test('GitHub deployment webhook accepts only signed requests for this repository', async t => {
  const calls = [];
  const secret = 'test webhook secret';
  const app = createEyesServer({ githubWebhookOptions: {
    secret,
    sync: async call => calls.push(call)
  } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const payload = JSON.stringify({
    ref: 'refs/heads/main',
    repository: { full_name: 'mzyhot/eyes.tools' }
  });
  const signature = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
  const post = (body = payload, headers = {}) => fetch(base + '/api/github/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature, ...headers },
    body
  });

  const get = await fetch(base + '/api/github/sync');
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  await get.arrayBuffer();

  const unsigned = await fetch(base + '/api/github/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  assert.equal(unsigned.status, 401);
  await unsigned.arrayBuffer();

  const bad = await post(payload, { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) });
  assert.equal(bad.status, 401);
  await bad.arrayBuffer();

  const wrongRepository = JSON.stringify({ repository: { full_name: 'someone/else' } });
  const wrongSignature = 'sha256=' + createHmac('sha256', secret).update(wrongRepository).digest('hex');
  const refused = await post(wrongRepository, { 'X-Hub-Signature-256': wrongSignature });
  assert.equal(refused.status, 403);
  await refused.arrayBuffer();

  const accepted = await post(payload, { 'X-GitHub-Event': 'push', 'X-GitHub-Delivery': 'delivery-1' });
  assert.equal(accepted.status, 202);
  assert.deepEqual(calls, [{
    delivery: 'delivery-1',
    event: 'push',
    payload: { ref: 'refs/heads/main', repository: { full_name: 'mzyhot/eyes.tools' } }
  }]);
  assert.deepEqual(await accepted.json(), { accepted: true });
});

test('starts when run through a symlinked release directory', { timeout: 10000 }, async t => {
  // deploy/README.md runs the server as /opt/eyes/current/dev-server.mjs, where
  // `current` is a symlink to the release.
  const scratch = await mkdtemp(join(tmpdir(), 'eyes-link-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const current = join(scratch, 'current');
  await symlink(dirname(fileURLToPath(new URL('../dev-server.mjs', import.meta.url))), current, 'dir');
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = String(probe.address().port);
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [join(current, 'dev-server.mjs'), port], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  const started = await new Promise(resolve => {
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('running at')) resolve(true); });
    child.on('exit', () => resolve(false));
  });
  assert.equal(started, true);
});

test('static hosts send the same security headers, with inline scripts allowed', async t => {
  const { STATIC_HEADERS, pageSlugs, pagesHeaders, vercelConfig } = await import('../scripts/static-routes.mjs');
  const app = createEyesServer();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const res = await fetch(`http://127.0.0.1:${app.server.address().port}/json`);
  for (const [name, value] of Object.entries(STATIC_HEADERS)) {
    if (name !== 'Content-Security-Policy') { assert.equal(res.headers.get(name), value, name); continue; }
    /* The server's policy for a page is the base policy plus that page's
       script hashes; the static one swaps the hashes for 'unsafe-inline'. */
    const served = res.headers.get(name).replace(/ 'sha256-[^']+'/g, '');
    assert.equal(value, served + " 'unsafe-inline'");
  }
  const vercel = JSON.parse(vercelConfig(await pageSlugs()));
  assert.deepEqual(vercel.headers, [{ source: '/(.*)', headers: Object.entries(STATIC_HEADERS).map(([key, value]) => ({ key, value })) }]);
  const pages = pagesHeaders();
  assert.match(pages, /^\/\*$/m);
  for (const [name, value] of Object.entries(STATIC_HEADERS)) assert.ok(pages.includes(`\n  ${name}: ${value}\n`), name);
});
