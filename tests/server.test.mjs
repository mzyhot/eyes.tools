import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEyesServer } from '../dev-server.mjs';

test('production HTTP boundaries, security headers, and graceful shutdown', async t => {
  const app = createEyesServer();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = path => fetch(base + path);
  for (const path of ['/', '/share', '/json', '/s.js', '/site.js', '/theme.js', '/fonts.css', '/index.js', '/THIRDPARTYLICENSES', '/LICENSE', '/ADDENDUM']) {
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
  for (const path of ['/dev-server.mjs', '/share-server.mjs', '/public-files.mjs', '/README.md', '/tests/server.test.mjs', '/.git/config', '/.env', '/package.json', '/s.js.bak', '/%2e%2e%2fetc/passwd', '/%ZZ', '/t/%2e%2e%2fshare-server.mjs']) {
    const res = await get(path);
    assert.equal(res.status, 404, path);
    // The not-found page has no inline script, so the base policy covers it.
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'$/);
    await res.arrayBuffer();
  }
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
