import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSubdomainLookup, lookupSubdomains, normalizeApex } from '../subdomains-core.mjs';

test('domains normalize IDNs and reject URLs, credentials, IPs and malformed labels', () => {
  assert.equal(normalizeApex(' *.EXAMPLE.com '), 'example.com');
  assert.equal(normalizeApex('bücher.de'), 'xn--bcher-kva.de');
  for (const value of ['http://example.com', 'example.com:443', 'example.com/a', 'x@example.com', 'example.com\\evil', '127.0.0.1', 'example..com', '-a.com', 'localhost', 'a.c', 'example.com.', '', null]) assert.throws(() => normalizeApex(value));
});

test('upstream results are scoped, deduplicated, sorted and date validated', async () => {
  const result = await lookupSubdomains('example.com', { fetchImpl: async url => {
    assert.equal(url.hostname, 'crt.name');
    assert.equal(url.searchParams.get('apex'), 'example.com');
    return new Response('z.example.com\t2024-03-01\n*.a.example.com\t2024-02-29\na.example.com\t2023-01-01\nevil.com\t2020-01-01\nb.example.com\t2024-02-31\nexample.com.evil.com\n', { headers: { 'Content-Type': 'text/plain' } });
  } });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.results, [{ sub: 'a.example.com', first_seen: '2023-01-01' }, { sub: 'b.example.com', first_seen: '' }, { sub: 'z.example.com', first_seen: '2024-03-01' }]);
});

test('upstream reads are bounded and failures become safe status responses', async () => {
  const fetchImpl = async () => new Response('a.example.com\nb.example.com\nc.example.com\n', { headers: { 'Content-Type': 'text/plain' } });
  const capped = await lookupSubdomains('example.com', { fetchImpl, maxResults: 2 });
  assert.equal(capped.body.count, 2); assert.equal(capped.body.truncated, true);
  const bytes = await lookupSubdomains('example.com', { fetchImpl, maxBytes: 16 });
  assert.deepEqual(bytes.body.results, [{ sub: 'a.example.com', first_seen: '' }]); assert.equal(bytes.body.truncated, true);
  for (const [upstream, expected] of [[400, 400], [429, 503], [500, 502]]) {
    assert.equal((await lookupSubdomains('example.com', { fetchImpl: async () => new Response('error', { status: upstream }) })).status, expected);
  }
  assert.equal((await lookupSubdomains('example.com', { fetchImpl: async () => new Response('<html>challenge</html>', { headers: { 'Content-Type': 'text/html' } }) })).status, 502);
  assert.equal((await lookupSubdomains('example.com', { timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) })).status, 504);
});

test('lookup cache shares work, expires, bounds concurrency and retries failures', async () => {
  let finish, calls = 0, clock = 0;
  const lookup = createSubdomainLookup({ maxConcurrent: 1, ttlMs: 10, now: () => clock, lookup: apex => { calls++; return new Promise(resolve => { finish = status => resolve({ status, body: { apex } }); }); } });
  const first = lookup('EXAMPLE.com'), second = lookup('example.com');
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal((await lookup('other.com')).status, 503);
  finish(200); assert.deepEqual(await first, await second);
  await lookup('example.com'); assert.equal(calls, 1);
  clock = 11;
  const expired = lookup('example.com'); await Promise.resolve(); finish(502); await expired;
  const retry = lookup('example.com'); await Promise.resolve(); finish(200); await retry;
  assert.equal(calls, 3);
});
