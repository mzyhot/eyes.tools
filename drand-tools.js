/* 𓁹𓁹 — shared randomness sources.
 *
 * Three tools (rng, dice, coin) draw their randomness through this module, and
 * rng lets the visitor choose where it comes from; dice and coin always use the
 * drand beacon. It exposes a single global, `R`.
 *
 * The three sources, weakest first:
 *
 *   prng   `Math.random()`. Fast, reproducible in principle, and unsuitable for
 *          anything that matters. Offered because sometimes a visitor wants to
 *          see what a non-cryptographic generator looks like.
 *
 *   csrng  The Web Crypto API. The right default: unpredictable, local, and it
 *          reveals nothing to anybody.
 *
 *   trng   The League of Entropy drand beacon, via Cloudflare's relay. This is
 *          the only source that leaves the browser, and the only one whose
 *          output a third party can check afterwards: each beacon carries a BLS
 *          signature that the vendored client verifies against a pinned chain
 *          hash and collective public key before the bytes are used. A visitor
 *          can hand someone the round number and have them confirm the draw was
 *          not chosen after the fact.
 *
 * Three details of the drand path are deliberate.
 *
 *   Freshness. A beacon already published is a beacon someone could have looked
 *   up first, so a draw never reuses a round this browsing session has already
 *   drawn from. `latestFreshBeacon` waits for the next round rather than
 *   returning one it has seen, under a hard timeout in case the chain stalls.
 *
 *   Expansion. A beacon is 32 bytes. A request for more is not answered by
 *   asking for more beacons — that would leak how much is wanted and multiply
 *   the network cost — but by a domain-separated SHA-256 counter stream keyed
 *   by the beacon and its round, which is deterministic from the verified
 *   value and therefore still checkable.
 *
 *   Serialization. Draws are queued, so two clicks cannot race for the same
 *   round and hand back identical "independent" results.
 *
 * Verification is never disabled. A value that cannot be verified is an error,
 * not a fallback.
 */
(function () {
  "use strict";

  /* The League of Entropy quicknet chain: 3-second rounds, unchained, with
     signatures on G1. Both values are pinned here so a compromised or
     substituted relay cannot serve a different chain unnoticed — the client
     checks what it fetches against them. */
  var CHAIN_HASH = "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971";
  var PUBLIC_KEY = "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a";
  var ENDPOINT = "https://drand.cloudflare.com/" + CHAIN_HASH;

  /* The last round drawn from, kept per tab so a reload does not silently
     re-offer a round the visitor already saw. sessionStorage, not local: the
     guarantee is about this sitting, not this device. */
  var LAST_ROUND_KEY = "eyes.drand.quicknet.last-round";
  var MAX_BYTES = 4096;
  var POLL_MS = 300;
  var FRESH_TIMEOUT_MS = 12000;
  /* Domain separation for the expansion stream: bytes derived here can never
     collide with bytes derived for some other purpose from the same beacon. */
  var STREAM_DOMAIN = new TextEncoder().encode("eyes/drand/quicknet/sha256-stream/v1");

  var lastRound = readLastRound();
  var trngQueue = Promise.resolve();
  var chainClient = null;

  /* Nibble table, so hex decoding is two lookups per byte rather than a parse. */
  var NIBBLE = {};
  (function () {
    var digits = "0123456789abcdef", i;
    for (i = 0; i < 16; i++) {
      NIBBLE[digits[i]] = i;
      NIBBLE[digits[i].toUpperCase()] = i;
    }
  })();

  /**
   * Decode hex from the relay, refusing anything that is not hex — a truncated
   * or HTML response must fail loudly rather than become "randomness".
   * @param {string} hex
   * @returns {Uint8Array}
   */
  function fromHex(hex) {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2) throw new Error("invalid randomness returned by drand");
    var out = new Uint8Array(hex.length / 2), i;
    for (i = 0; i < out.length; i++) out[i] = (NIBBLE[hex[i * 2]] << 4) | NIBBLE[hex[i * 2 + 1]];
    return out;
  }

  /**
   * Validate a requested byte count.
   * @param {number} [n=32]
   * @returns {number}
   * @throws {Error} Outside 1…MAX_BYTES, or not an integer.
   */
  function requestedBytes(n) {
    n = n === undefined ? 32 : Number(n);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_BYTES) throw new Error("invalid random byte count");
    return n;
  }

  function readLastRound() {
    try {
      var value = Number(sessionStorage.getItem(LAST_ROUND_KEY));
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch (_) {
      return 0;
    }
  }

  function rememberRound(round) {
    lastRound = round;
    try { sessionStorage.setItem(LAST_ROUND_KEY, String(round)); } catch (_) {}
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * The two local sources. Neither is verifiable and both say so.
   * @param {"prng"|"csrng"} mode
   * @param {number} n Bytes wanted.
   * @returns {Promise<{bytes: Uint8Array, source: string, verified: boolean}>}
   */
  function local(mode, n) {
    n = requestedBytes(n);
    var out = new Uint8Array(n), i;
    if (mode === "prng") {
      for (i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
      return Promise.resolve({ bytes: out, source: "Math.random()", verified: false });
    }
    var source = window.crypto || window.msCrypto;
    if (!source || typeof source.getRandomValues !== "function") return Promise.reject(new Error("Web Crypto API is unavailable"));
    source.getRandomValues(out);
    return Promise.resolve({ bytes: out, source: "Web Crypto API", verified: false });
  }

  /**
   * The verifying drand client, built once per page.
   *
   * The chain is reused across draws because it caches the chain's immutable
   * parameters — public key, period, genesis — after fetching them once.
   * Rebuilding it per draw costs an extra network round trip before every roll.
   * Beacon freshness is unaffected: `noCache` puts a cache-busting parameter on
   * each beacon request, and the round check below is what actually enforces it.
   */
  function client() {
    if (chainClient) return chainClient;
    var options = {
      disableBeaconVerification: false,
      noCache: true,
      chainVerificationParams: { chainHash: CHAIN_HASH, publicKey: PUBLIC_KEY }
    };
    var chain = new Drand.HttpCachingChain(ENDPOINT, options);
    chainClient = new Drand.HttpChainClient(chain, options);
    return chainClient;
  }

  /**
   * Fetch a beacon this session has not drawn from, polling for the next round
   * if the latest one has already been used.
   *
   * Two deadlines guard it: a check at every step, and a racing timer, so
   * neither a stalled chain nor a relay that answers slowly forever can leave
   * the visitor waiting on a spinner.
   *
   * @param {object} c A drand chain client.
   * @returns {Promise<object>} A verified beacon.
   */
  function latestFreshBeacon(c) {
    var after = lastRound;
    var deadline = Date.now() + FRESH_TIMEOUT_MS;
    var expired = false, timer;
    function checkDeadline() {
      if (expired || Date.now() >= deadline) throw new Error("drand took too long to respond; try again");
    }

    function poll() {
      checkDeadline();
      return c.latest().then(function (candidate) {
        checkDeadline();
        var round = Number(candidate.round);
        if (!Number.isSafeInteger(round) || round < 1) throw new Error("invalid round returned by drand");

        if (after && round <= after) {
          if (Date.now() >= deadline) throw new Error("the next drand round is taking too long; try again");
          return delay(POLL_MS).then(poll);
        }

        /* Re-fetch the round explicitly: fetchBeacon is the call that verifies
           the signature against the pinned chain. */
        return Drand.fetchBeacon(c, round).then(function (beacon) {
          checkDeadline();
          rememberRound(beacon.round);
          return beacon;
        });
      });
    }

    var timeout = new Promise(function (_, reject) {
      timer = setTimeout(function () { expired = true; reject(new Error("drand took too long to respond; try again")); }, FRESH_TIMEOUT_MS);
    });
    return Promise.race([poll(), timeout]).finally(function () { clearTimeout(timer); expired = true; });
  }

  /** Write a 64-bit big-endian value. Uses BigInt: rounds outrun 2^32. */
  function setUint64(out, at, value) {
    value = BigInt(value);
    for (var i = 7; i >= 0; i--) {
      out[at + i] = Number(value & 255n);
      value >>= 8n;
    }
  }

  /** Write a 32-bit big-endian value. */
  function setUint32(out, at, value) {
    out[at] = value >>> 24;
    out[at + 1] = value >>> 16;
    out[at + 2] = value >>> 8;
    out[at + 3] = value;
  }

  /**
   * Stretch a 32-byte beacon to n bytes.
   *
   * SHA-256 over `domain ‖ 0 ‖ beacon ‖ round ‖ counter`, with the counter
   * incrementing per block. Deterministic given the verified beacon, so anyone
   * holding the round number can reproduce every byte — which is the point: the
   * expansion must not weaken the claim that the result was not chosen later.
   *
   * A request that fits in the beacon itself is answered from it directly, and
   * the result says which of the two happened.
   *
   * @param {Uint8Array} seed The beacon randomness.
   * @param {number|string} round Its round number.
   * @param {number} n Bytes wanted.
   * @returns {Promise<Uint8Array>}
   */
  function expandBeacon(seed, round, n) {
    var out = new Uint8Array(n);
    var copied = Math.min(seed.length, n);
    out.set(seed.subarray(0, copied));
    if (copied === n) return Promise.resolve(out);
    var source = window.crypto || window.msCrypto;
    if (!source || !source.subtle) return Promise.reject(new Error("Web Crypto API is required to expand drand randomness"));

    var input = new Uint8Array(STREAM_DOMAIN.length + 1 + seed.length + 8 + 4);
    input.set(STREAM_DOMAIN, 0);
    input[STREAM_DOMAIN.length] = 0;
    input.set(seed, STREAM_DOMAIN.length + 1);
    setUint64(input, STREAM_DOMAIN.length + 1 + seed.length, round);
    var counterAt = input.length - 4;
    var counter = 1;

    /* Only the counter changes between blocks, so the input buffer is written
       once and rewound rather than rebuilt. */
    function nextBlock() {
      setUint32(input, counterAt, counter++);
      return source.subtle.digest("SHA-256", input).then(function (digest) {
        var block = new Uint8Array(digest);
        var part = block.subarray(0, Math.min(block.length, n - copied));
        out.set(part, copied);
        copied += part.length;
        return copied < n ? nextBlock() : out;
      });
    }

    return nextBlock();
  }

  /**
   * One verified drand draw.
   * @param {number} n Bytes wanted.
   * @returns {Promise<object>} Bytes plus everything needed to check them later:
   *   the round, its signature, the raw randomness, the derivation used, and
   *   the chain hash they belong to.
   */
  function runTrng(n) {
    if (!window.Drand) return Promise.reject(new Error("drand verifier did not load"));
    try { n = requestedBytes(n); } catch (error) { return Promise.reject(error); }
    return latestFreshBeacon(client()).then(function (beacon) {
      var seed = fromHex(beacon.randomness);
      return expandBeacon(seed, beacon.round, n).then(function (bytes) {
        return {
          bytes: bytes,
          source: "Cloudflare drand quicknet · League of Entropy",
          verified: true,
          round: beacon.round,
          signature: beacon.signature,
          randomness: beacon.randomness,
          derivation: n > seed.length ? "SHA-256 counter stream v1" : "raw beacon bytes",
          chainHash: CHAIN_HASH
        };
      });
    });
  }

  /* Serialize draws. Two clicks in flight at once would otherwise race for the
     same round and produce two "independent" results from one beacon. A failed
     draw must not poison the queue, so the chain absorbs rejections. */
  function trng(n) {
    var task = trngQueue.then(function () { return runTrng(n); });
    trngQueue = task.then(function () {}, function () {});
    return task;
  }

  /**
   * Draw n bytes from the chosen source.
   * @param {"prng"|"csrng"|"trng"} mode
   * @param {number} n Bytes wanted, 1…4096.
   * @returns {Promise<{bytes: Uint8Array, source: string, verified: boolean}>}
   */
  function source(mode, n) { return mode === "trng" ? trng(n) : local(mode, n); }

  /**
   * An unbiased integer in [0, max) drawn from a byte buffer.
   *
   * Rejection sampling, not modulo: taking `x % max` over the whole 64-bit range
   * would favour the low end of any range that does not divide 2^64 evenly.
   * Values at or above the largest exact multiple of `max` are discarded and the
   * next eight bytes tried, which is exactly unbiased at the cost of consuming a
   * little more entropy — hence the headroom `byteCount` allows for.
   *
   * @param {Uint8Array} bytes Buffer to draw from.
   * @param {number|bigint} max Exclusive upper bound, 1…2^64.
   * @param {number} [offset=0] Where to start reading.
   * @returns {{value: bigint, offset: number}} The value and where to resume.
   * @throws {Error} If the buffer runs out before an accepted value.
   */
  function uniform(bytes, max, offset) {
    max = BigInt(max);
    if (max < 1n || max > (1n << 64n)) throw new Error("range must fit in 64 bits");
    var at = offset || 0, width = 8, space = 1n << 64n, limit = space - (space % max);
    while (at + width <= bytes.length) {
      var x = 0n;
      for (var i = 0; i < width; i++) x = (x << 8n) | BigInt(bytes[at + i]);
      at += width;
      if (x < limit) return { value: x % max, offset: at };
    }
    throw new Error("not enough unbiased random bytes; draw again");
  }

  /**
   * How many bytes to draw for `count` unbiased values below `max`.
   *
   * Eight bytes per value, plus sixteen values of slack so the rejections above
   * almost never exhaust the buffer and force a second network round trip.
   *
   * @param {number|bigint} max Exclusive upper bound.
   * @param {number} count How many values are wanted, clamped to 1…100.
   * @returns {number} Bytes to request.
   */
  function byteCount(max, count) {
    max = BigInt(max);
    if (max < 1n || max > (1n << 53n)) throw new Error("range is too large");
    count = Math.max(1, Math.min(100, Math.floor(Number(count) || 1)));
    return 8 * (count + 16);
  }

  window.R = { source: source, uniform: uniform, byteCount: byteCount, chainHash: CHAIN_HASH, endpoint: ENDPOINT };
})();
