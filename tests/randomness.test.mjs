import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
const source = await readFile(new URL('../drand-tools.js', import.meta.url), 'utf8');
function load(extra = {}) {
  const saved = new Map();
  const scope = { TextEncoder, Uint8Array, BigInt, Promise, Date, Math, setTimeout, clearTimeout, crypto: webcrypto,
    sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) }, ...extra };
  scope.window = scope;
  runInNewContext(source, scope);
  return { R: scope.R, saved };
}

test('random sources enforce bounds and rejection sampling avoids modulo bias', async () => {
  const { R } = load();
  const local = await R.source('csrng', 32);
  assert.equal(local.bytes.length, 32); assert.equal(local.verified, false);
  assert.throws(() => R.source('csrng', 4097), /byte count/);
  const bytes = new Uint8Array(16); bytes.fill(255, 0, 8);
  const draw = R.uniform(bytes, 3n);
  assert.equal(draw.value, 0n); assert.equal(draw.offset, 16);
  assert.throws(() => R.uniform(new Uint8Array(7), 2n), /unbiased/);
});

test('a stalled drand request times out, cannot update state later, and releases the queue', async () => {
  const timers = new Map(); let timerID = 0, resolveLatest, stalled = true, verifies = 0;
  const Drand = {
    HttpCachingChain: class { constructor(_, options) { assert.equal(options.disableBeaconVerification, false); assert.equal(options.chainVerificationParams.chainHash.length, 64); } },
    HttpChainClient: class { latest() { return stalled ? new Promise(resolve => { resolveLatest = resolve; }) : Promise.resolve({ round: 200 }); } },
    fetchBeacon: async (_, round) => { verifies++; return { round, randomness: 'ab'.repeat(32), signature: 'fixture' }; }
  };
  const { R, saved } = load({ Drand, setTimeout: (fn, ms) => { const id = ++timerID; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  const first = R.source('trng', 32);
  const rejected = assert.rejects(first, /too long/);
  await new Promise(resolve => setImmediate(resolve));
  [...timers.values()].find(t => t.ms === 12000).fn();
  await rejected;
  resolveLatest({ round: 100 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(saved.size, 0); assert.equal(verifies, 0);
  stalled = false;
  const retry = await R.source('trng', 64);
  assert.equal(retry.verified, true); assert.equal(retry.round, 200); assert.equal(retry.bytes.length, 64);
  assert.equal(verifies, 1); assert.equal(timers.size, 0);
});
