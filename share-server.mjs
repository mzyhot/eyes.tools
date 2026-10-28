/* 𓁹𓁹: share discovery and WebRTC signaling.
 *
 * File bytes never pass through this service. It does three things and nothing
 * else: it tells two browsers that they are in the same place, it relays the
 * handshake they need to open a direct connection, and it gets out of the way.
 * Once the peer connection is up, the transfer is browser to browser.
 *
 * The model
 *
 *   A *session* is one open share tab. It holds an id, a bearer token, a room,
 *   a display name, and, while the tab is open, a server-sent event stream.
 *
 *   A *room* is a hashed string that decides who can see whom. A session joins
 *   the room its link names, or, with no link, the room named by its own id,
 *   which it hands back as the link to pass on. That is the whole of the room
 *   bookkeeping: a room exists while someone is in it, its code is unique
 *   because session ids are, and a link reaches nobody once the tab that
 *   minted it has gone.
 *
 *   A *network* is the second way to meet, as ShareDrop did it: sessions that
 *   arrive from one public network (one IPv4 address, or one IPv6 /64) see
 *   each other too, link or not. It is only used when the address is the
 *   visitor's own; a loopback, private or proxy address leaves the session to
 *   its link alone. An IPv6 address that carries an IPv4 one (mapped, 6to4,
 *   Teredo) counts as that IPv4 network, so a device reaching the site
 *   through one of those meets the IPv4 devices behind the same router. A
 *   session is placed again each time its event stream reopens, so a phone
 *   that moves from mobile data to the Wi-Fi finds the devices there. It
 *   misses whenever Private Relay, a VPN or IPv6 on one device makes one
 *   network look like two, which is why the link stays.
 *
 *   A session's events arrive on one long response. A network that holds a
 *   response back until it ends (some company proxies and antivirus web
 *   shields do) would deliver nothing, so a client that hears nothing asks
 *   instead in a series of short requests, each answered with whatever has
 *   happened since the last.
 *
 *   Nothing is persisted. Everything is in memory and dies with the process,
 *   which is the intended lifetime: discovery is ephemeral by design.
 *
 * What is deliberately defensive
 *
 *   Room and network keys are HMACs under a per-process salt, never raw
 *   addresses or raw link codes, so the in-memory state does not accumulate
 *   readable network identifiers and a leaked key reveals nothing and works
 *   nowhere else.
 *
 *   Joins are rate limited per network, which needs the visitor's address.
 *   It is only believed when the operator has said this process sits behind
 *   Cloudflare *and* the request arrived from loopback with a valid
 *   `CF-Connecting-IP`, or arrived from a proxy the operator listed in
 *   `SHARE_TRUSTED_PROXIES` with a valid address in the header it names, or
 *   when no proxy header is present at all; anything ambiguous is counted
 *   against the proxy's own address instead. The same
 *   rule decides whether the address may group visitors into a network, with
 *   one more condition: it must be public, because a loopback or private
 *   address belongs to a proxy or a LAN and would put strangers together.
 *   A network holds no more sessions than a room; past that, newcomers meet
 *   by link alone.
 *
 *   Requests must be same-origin, or come from an origin the operator has
 *   listed in `SHARE_ALLOWED_ORIGINS`: the desktop app's, which serves its
 *   pages itself and uses this service only for discovery and signaling. Only
 *   those origins get CORS headers, and the list is empty unless set, so a
 *   page on another domain cannot enumerate anyone.
 *
 *   Tokens are compared in constant time, every payload is size-capped before
 *   it is parsed, joins and signals are rate limited per address and per
 *   session, and room size, sessions and streams all have hard ceilings.
 *
 * Bookkeeping
 *
 *   `sessions` is keyed by id. `roomMembers` and `networkMembers` index those
 *   same sessions by room and by network, so finding someone's peers and
 *   counting a group are proportional to the group rather than to everyone
 *   connected. The three must be updated together; `remember` and `forget`
 *   are the only places that do it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import { originPolicy } from './request-origin.mjs';

/* Display names. Two words plus the session's short code, so a visitor can tell
   which device in the list is theirs without anything identifying appearing. */
const NAMES = ['quiet fox', 'silver heron', 'little owl', 'calm otter', 'swift finch', 'still deer', 'pale moth', 'soft lynx'];

/* How often to sweep dead sessions and to ping live streams. */
const SWEEP_MS = 15000;
/* A session with no stream is collected this long after it was last seen. */
const SESSION_GRACE_MS = 45000;
/* All rate limits use this window. */
const RATE_WINDOW_MS = 60000;
const MAX_JOINS_PER_WINDOW = 30;
const MAX_SIGNALS_PER_WINDOW = 1000;
const MAX_SESSIONS = 1000;
const MAX_ROOM_MEMBERS = 16;
const MAX_RATE_KEYS = 10000;
/* A stream this far behind is a client that has stopped reading; drop it rather
   than buffer for it. */
const MAX_STREAM_BACKLOG = 262144;
const MAX_BODY_BYTES = 65536;
/* SDP and ICE candidates are relayed unread, so they are bounded by length
   alone: enough for a real offer, far short of useful as a message channel. */
const MAX_SDP_LENGTH = 60000;
const MAX_CANDIDATE_LENGTH = 4096;
/* A client collecting its events in short requests: each is held this long
   when there is nothing to say, and the session counts as gone once no
   request has arrived for POLL_GAP_MS after the last answer. */
const POLL_WAIT_MS = 20000;
const POLL_GAP_MS = 15000;

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
/* Any of these means a proxy sits in front, so the socket address is the
   proxy's, shared by every visitor behind it. */
const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'true-client-ip', 'fly-client-ip'];
/* Cloudflare's STUN service answers on UDP 443 as well as 3478, and a network
   that blocks the one often lets the other through, as it does QUIC. */
const STUN_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:443'];

/**
 * Expand a valid IPv6 address to its eight 16-bit groups.
 *
 * Handles `::` compression, a trailing dotted IPv4 part and a zone suffix.
 * The caller has already confirmed the address with `isIP`, so this only has to
 * be correct for valid input.
 * @param {string} ip
 * @returns {number[]} Eight integers, 0–65535.
 */
export function expandIPv6(ip) {
  let text = ip.split('%')[0].toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const split = text.indexOf('::');
  const head = split < 0 ? text : text.slice(0, split);
  const tail = split < 0 ? '' : text.slice(split + 2);
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = split < 0 ? 0 : 8 - left.length - right.length;
  return [...left, ...Array(zeros).fill('0'), ...right].map(group => parseInt(group, 16));
}

/**
 * The part of an address that identifies a network rather than one device.
 *
 * Joins are counted against this, so that one visitor cannot spend everyone's
 * limit and cannot escape their own.
 *
 * IPv4 behind a home router is already shared: every device on the Wi-Fi
 * leaves through one public address, so the address *is* the network.
 *
 * IPv6 is not. Each device gets its own public address and usually rotates a
 * temporary one besides, so counting by the full address lets one client
 * rotate through 2^64 of them and never reach the limit. What the devices on
 * one link share is the /64 prefix the router hands out, so the count goes
 * there. Mobile carriers give each phone its own /64, so one phone's joins
 * never count against another's.
 *
 * An IPv6 address that carries an IPv4 one is reduced to that IPv4 address,
 * so every spelling of one network agrees: IPv4-mapped (`::ffff:a.b.c.d`,
 * what a dual-stack socket reports for an IPv4 client), 6to4 (`2002::/16`,
 * which embeds the router's public address) and Teredo (`2001::/32`, which
 * embeds, inverted, the public address of the NAT the client is behind).
 * Neither tunnel can be spoofed into someone else's network: an answer to the
 * address would go to the IPv4 address it embeds.
 *
 * @param {string} ip A valid IP address.
 * @returns {string} A stable network identifier.
 */
export function networkOf(ip) {
  const family = isIP(ip);
  if (family !== 6) return ip;
  const groups = expandIPv6(ip);
  return embeddedIPv4(groups) || groups.slice(0, 4).map(group => group.toString(16)).join(':') + '::/64';
}

/** The IPv4 address an IPv4-mapped, 6to4 or Teredo address carries, or null. */
function embeddedIPv4(groups) {
  const dotted = (high, low) => [high >> 8, high & 255, low >> 8, low & 255].join('.');
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) return dotted(groups[6], groups[7]);
  if (groups[0] === 0x2002) return dotted(groups[1], groups[2]);
  if (groups[0] === 0x2001 && groups[1] === 0) return dotted(groups[6] ^ 0xffff, groups[7] ^ 0xffff);
  return null;
}

/** An address as a 128-bit number, IPv4 in its mapped form, so one comparison serves both families. */
function addressValue(ip) {
  return expandIPv6(isIP(ip) === 4 ? '::ffff:' + ip : ip).reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

/**
 * A test for membership in a list of addresses and CIDR ranges, such as
 * `127.0.0.1, 10.0.0.0/8, fd00::/8`. An IPv4 range also matches the mapped
 * spelling of its addresses. Anything unparseable in the list is an error,
 * not a silent omission: a proxy the operator meant to trust and this process
 * does not would quietly stop every network from being known.
 * @param {string} [list] Comma-separated.
 * @returns {(ip: string) => boolean}
 */
export function addressList(list) {
  const ranges = (list || '').split(',').map(entry => entry.trim()).filter(Boolean).map(entry => {
    const [address, bits, extra] = entry.split('/');
    const family = isIP(address);
    const width = family === 4 ? 32 : 128;
    const prefix = bits === undefined ? width : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
    if (!family || extra !== undefined || !(prefix >= 0 && prefix <= width)) throw new TypeError('not an address or range: ' + entry);
    const shift = BigInt(128 - (family === 4 ? 96 + prefix : prefix));
    return { shift, network: addressValue(address) >> shift };
  });
  return ip => isIP(ip) !== 0 && ranges.some(range => addressValue(ip) >> range.shift === range.network);
}

/**
 * The address a proxy says it forwarded for, from a header that may name
 * several hops. The proxy nearest this process appends last, so the hops are
 * read from the right, passing over the operator's own proxies, and the first
 * one that is not a proxy is the visitor; anything to its left was written by
 * the visitor and is not believed. A hop that is not an address ends the
 * search, as does a header naming nobody but proxies.
 * @param {string} header The header's value, repeated headers joined by commas.
 * @param {boolean} forwarded Whether it is RFC 7239 `Forwarded` syntax.
 * @param {(ip: string) => boolean} isProxy
 * @returns {string|null}
 */
export function forwardedFor(header, forwarded, isProxy) {
  const hops = header.split(',').map(hop => forwarded
    ? (/(?:^|;)\s*for\s*=\s*("?)([^";]*)\1\s*(?:;|$)/i.exec(hop)?.[2] ?? '') : hop);
  for (let i = hops.length - 1; i >= 0; i--) {
    /* `[2001:db8::1]:4711`, `192.0.2.7:4711`, or a bare address. */
    const hop = hops[i].trim(), ip = /^\[([^\]]+)\](?::\d+)?$/.exec(hop)?.[1] ?? (/^[\d.]+:\d+$/.test(hop) ? hop.split(':')[0] : hop);
    if (!isIP(ip)) return null;
    if (!isProxy(ip)) return ip;
  }
  return null;
}

/**
 * Whether an address is one many visitors could share without being on one
 * network: loopback, private, link-local, carrier-grade NAT or unspecified.
 *
 * Such an address is a proxy's, a LAN's or a carrier's, never one household's,
 * so it never groups visitors. Anything that is not an address counts too.
 * @param {string} ip
 * @returns {boolean}
 */
export function isLocalAddress(ip) {
  let v4 = isIP(ip) === 4 ? ip : null;
  if (isIP(ip) === 6) {
    const groups = expandIPv6(ip);
    v4 = embeddedIPv4(groups);
    if (!v4) {
      const unspecifiedOrLoopback = groups.slice(0, 7).every(group => group === 0) && groups[7] <= 1;
      /* fc00::/7 is unique-local, fe80::/10 link-local. */
      return unspecifiedOrLoopback || (groups[0] & 0xfe00) === 0xfc00 || (groups[0] & 0xffc0) === 0xfe80;
    }
  }
  if (!v4) return true;
  const [a, b] = v4.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128);
}

/**
 * Build the share service.
 *
 * @param {object} [options]
 * @param {boolean} [options.trustCloudflare] Whether `CF-Connecting-IP` from
 *   loopback may be believed, for rate limiting per visitor rather than per
 *   proxy. Opt-in: behind a proxy without it, one visitor's joins count
 *   against everyone's limit.
 * @param {string} [options.trustedProxies] Comma-separated addresses and CIDR
 *   ranges of the operator's own reverse proxies (nginx, Caddy, a load
 *   balancer), whose `proxyHeader` names the visitor. Empty by default.
 * @param {string} [options.proxyHeader] The header those proxies set:
 *   `x-forwarded-for` (the default), `forwarded`, `x-real-ip`, or another
 *   that holds addresses.
 * @param {string} [options.turnSecret] Shared secret for time-limited TURN
 *   credentials. Never leaves the process; only the derived HMAC is sent.
 * @param {string} [options.turnUrls] Comma-separated TURN URLs.
 * @param {string} [options.allowedOrigins] Comma-separated origins, besides
 *   this site's own, whose pages may use the service, such as the desktop app's
 *   `tauri://localhost` and `http://tauri.localhost`. Empty by default.
 * @param {{wait: number, gap: number}} [options.poll] How long a collecting
 *   request is held, and how long without one means the client is gone;
 *   POLL_WAIT_MS and POLL_GAP_MS unless a test shortens them.
 * @param {() => number} [options.now] Clock, injected for tests.
 * @param {(n: number) => Buffer} [options.random] Entropy, injected for tests.
 * @returns {{handle: Function, close: Function}}
 */
export function createShareService({ trustCloudflare = process.env.SHARE_TRUST_CLOUDFLARE === '1', trustedProxies = process.env.SHARE_TRUSTED_PROXIES, proxyHeader = process.env.SHARE_PROXY_HEADER || 'x-forwarded-for', turnSecret = process.env.SHARE_TURN_SECRET, turnUrls = process.env.SHARE_TURN_URLS, allowedOrigins = process.env.SHARE_ALLOWED_ORIGINS, poll = { wait: POLL_WAIT_MS, gap: POLL_GAP_MS }, now = Date.now, random = randomBytes } = {}) {
  /** @type {Map<string, object>} session id → session */
  const sessions = new Map();
  /** @type {Map<string, Set<object>>} room key → sessions in it */
  const roomMembers = new Map();
  /** @type {Map<string, Set<object>>} network key → sessions from it */
  const networkMembers = new Map();
  /** @type {Map<string, {count: number, start: number}>} hashed address → joins */
  const rates = new Map();
  /* Reserved short codes and tokens, so a collision is retried rather than
     silently overwriting a live session. */
  const codes = new Set(), tokens = new Set();
  const salt = randomBytes(32);

  /* TURN URLs and allowed origins are fixed for the process; parse them once
     rather than per request. */
  const turnUrlList = turnUrls ? turnUrls.split(',').map(v => v.trim()).filter(Boolean) : [];
  const { allowedCrossOrigin, sameOrigin } = originPolicy(allowedOrigins);
  const isProxy = addressList(trustedProxies);
  const visitorHeader = proxyHeader.trim().toLowerCase();
  const proxyHeaders = [...new Set([...PROXY_HEADERS, visitorHeader])];

  /**
   * Draw a unique random hex value, retrying on collision and failing closed.
   *
   * Broken or exhausted entropy must never take over a live session, so after
   * 32 attempts this raises a 503 rather than returning a value already in use.
   * @param {number} bytes Length in bytes.
   * @param {(value: string) => boolean} taken Collision test.
   */
  function allocate(bytes, taken) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const value = random(bytes).toString('hex');
      if (!taken(value)) return value;
    }
    const error = new Error('could not allocate a unique code; please try again');
    error.status = 503;
    throw error;
  }

  /* Rooms and networks are addressed by HMAC, never by the address or link
     they came from. */
  const key = value => createHmac('sha256', salt).update(value).digest('hex');

  /* What one peer is allowed to learn about another: never the token, never the
     address, never the room. */
  const publicPeer = s => ({ id: s.id, name: s.name, device: s.device });

  /** Add a session to a group index, creating the group. */
  function enter(index, group, s) {
    let members = index.get(group);
    if (!members) { members = new Set(); index.set(group, members); }
    members.add(s);
  }

  /** Drop a session from a group index, discarding the group once it is empty. */
  function exit(index, group, s) {
    const members = index.get(group);
    if (!members) return;
    members.delete(s);
    if (!members.size) index.delete(group);
  }

  /** Add a session to every index. */
  function remember(s) {
    sessions.set(s.id, s);
    enter(roomMembers, s.room, s);
    if (s.network) enter(networkMembers, s.network, s);
  }

  /** Drop a session from every index. */
  function forget(s) {
    sessions.delete(s.id);
    exit(roomMembers, s.room, s);
    if (s.network) exit(networkMembers, s.network, s);
  }

  /** How many sessions are in a group, without walking every session. */
  const groupSize = (index, group) => (index.get(group)?.size ?? 0);

  /** Whether two sessions may meet: one room, or one known network. */
  const related = (s, p) => p.room === s.room || (!!s.network && p.network === s.network);

  /** Everyone a session may meet, itself excepted, connected or not. */
  function neighbours(s) {
    const out = new Set(roomMembers.get(s.room));
    if (s.network) for (const p of networkMembers.get(s.network) ?? []) out.add(p);
    out.delete(s);
    return out;
  }

  /** The connected peers a session may see: its room and network, streaming. */
  const peers = s => [...neighbours(s)].filter(p => p.stream);

  /**
   * Write one server-sent event to a session's stream.
   *
   * A client that has stopped reading has its stream destroyed rather than
   * buffered for: an unbounded write queue is the one way this service could be
   * made to consume memory without bound.
   */
  const send = (s, type, data) => {
    if (!s.stream || s.stream.destroyed) return;
    if (s.stream.writableLength > MAX_STREAM_BACKLOG) { s.stream.destroy(); return; }
    s.stream.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  /** Send an event to everyone else in the room and the network. */
  const broadcast = (s, type, data) => {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const p of neighbours(s)) {
      if (!p.stream || p.stream.destroyed) continue;
      if (p.stream.writableLength > MAX_STREAM_BACKLOG) { p.stream.destroy(); continue; }
      p.stream.write(payload);
    }
  };

  /**
   * Retire a session: release its reserved code and token, tell the room it
   * left, and close its stream. Guarded so a stale reference, a delayed close
   * for a session whose id has since been reused, cannot remove a live one.
   */
  function remove(s) {
    if (sessions.get(s.id) !== s) return;
    forget(s);
    codes.delete(s.id.slice(-4));
    tokens.delete(s.token);
    broadcast(s, 'left', { id: s.id, removed: true });
    s.stream?.end();
  }

  /**
   * Housekeeping, every SWEEP_MS:
   *   · collect sessions whose tab closed and never came back;
   *   · ping live streams, which both keeps intermediaries from timing the
   *     connection out and surfaces sockets that have silently died;
   *   · forget rate-limit counters whose window has passed.
   */
  const sweep = setInterval(() => {
    const at = now();
    for (const s of sessions.values()) {
      if (!s.stream && at - s.seen > SESSION_GRACE_MS) remove(s);
      else if (s.stream) send(s, 'ping', {});
    }
    for (const [ip, rate] of rates) if (at - rate.start > RATE_WINDOW_MS) rates.delete(ip);
  }, SWEEP_MS);
  /* Never hold the process open for the sweep alone. */
  sweep.unref();

  /** Send a JSON response. Share responses are never cached or sniffed. */
  function reply(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(JSON.stringify(body));
  }

  /**
   * Read a JSON request body, refusing anything oversized before it is parsed.
   * Only a plain object is accepted; an array or a bare value is not a message.
   * @throws {Error} On the wrong content type, an oversized body, or bad JSON.
   */
  async function readBody(req) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new Error('use application/json');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw new Error('message too large');
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid message');
    return body;
  }

  /**
   * The ICE servers a session should use.
   *
   * STUN is enough for most pairs. TURN is only offered when an operator has
   * configured a relay, and then with an ephemeral credential, a username that
   * expires in an hour and an HMAC of it, so the shared secret never reaches
   * the browser.
   */
  function iceServers(id) {
    const servers = [{ urls: STUN_URLS }];
    if (turnSecret && turnUrlList.length) {
      const username = `${Math.floor(now() / 1000) + 3600}:${id}`;
      servers.push({ urls: turnUrlList, username,
        credential: createHmac('sha1', turnSecret).update(username).digest('base64') });
    }
    return servers;
  }

  /**
   * The address a request's joins are counted against, and whether it is
   * known to be the visitor's own network.
   *
   * Behind a trusted Cloudflare proxy, or one the operator listed, the address
   * is the visitor's; otherwise it is the socket address, which may be the
   * proxy's and so shared by everyone behind it. That is fine for a rate
   * limit, which then only counts too many people together, but not for
   * grouping, which would put them all in one network. So a network is known
   * only from a trusted header, or from a request that carries no proxy header
   * at all and did not come through a trusted proxy, and never from a
   * loopback or private address, which is a proxy's or a LAN's.
   */
  function locate(req) {
    const address = req.socket.remoteAddress || '';
    const cloudflare = req.headers['cf-connecting-ip'], header = req.headers[visitorHeader];
    let visitor = null;
    if (trustCloudflare && LOOPBACK.includes(address) && typeof cloudflare === 'string' && isIP(cloudflare)) visitor = cloudflare;
    else if (isProxy(address) && typeof header === 'string') visitor = forwardedFor(header, visitorHeader === 'forwarded', isProxy);
    const ip = visitor || address;
    const own = !!visitor || (!trustCloudflare && !isProxy(address) && !proxyHeaders.some(name => req.headers[name] !== undefined));
    return { ip, networkKnown: own && !isLocalAddress(ip) };
  }

  /** The network group a located request belongs to, or null. */
  const areaOf = ({ ip, networkKnown }) => networkKnown ? key('network:' + networkOf(ip)) : null;

  /**
   * Move a session to the network it is in now, if that has room. A network
   * already full when the session joined is tried again, since someone may
   * have left it. `area` is where the session is, `network` the group it is
   * in, which is null when that was full.
   */
  function relocate(s, area) {
    s.area = area;
    if (area === s.network) return;
    if (s.network) exit(networkMembers, s.network, s);
    s.network = area && groupSize(networkMembers, area) < MAX_ROOM_MEMBERS ? area : null;
    if (s.network) enter(networkMembers, s.network, s);
  }

  /* ── endpoints ───────────────────────────────────────── */

  /**
   * POST /api/share/join: create a session and return its credentials.
   *
   * With a room, the session joins it; without one, it joins the room its own
   * id names and hands that id back as the link to pass on. Either way it also
   * joins its network, when that is known and not already full.
   *
   * Rate limited per address. The id, its visible four-character short code and
   * the bearer token are all allocated and reserved without an await in between,
   * so two concurrent joins cannot be handed the same one.
   */
  async function join(req, res, place) {
    /* Rate limit per network: an IPv6 client can otherwise rotate through the
       2^64 addresses in its own /64 and never hit the limit. */
    const network = networkOf(place.ip);
    const rateKey = key(network), rate = rates.get(rateKey) || { count: 0, start: now() };
    if (now() - rate.start > RATE_WINDOW_MS) { rate.count = 0; rate.start = now(); }
    if (rates.size >= MAX_RATE_KEYS && !rates.has(rateKey)) return reply(res, 503, { error: 'share is busy; try again shortly' });
    rates.set(rateKey, rate);
    if (++rate.count > MAX_JOINS_PER_WINDOW) return reply(res, 429, { error: 'too many joins; try again in a minute' });

    const body = await readBody(req);
    if (body.room !== undefined && !/^[a-f0-9]{24}$/.test(body.room)) return reply(res, 400, { error: 'this room link is invalid' });

    const id = allocate(12, value => sessions.has(value) || codes.has(value.slice(-4)));
    const code = body.room || id;
    const room = key('room:' + code);
    if (sessions.size >= MAX_SESSIONS || groupSize(roomMembers, room) >= MAX_ROOM_MEMBERS) {
      return reply(res, 429, { error: 'this room is full; try a new room link' });
    }
    /* A full network is not refused: the newcomer still has its link. */
    const area = areaOf(place);

    const s = {
      id,
      token: allocate(32, value => tokens.has(value)),
      room,
      area,
      network: area && groupSize(networkMembers, area) < MAX_ROOM_MEMBERS ? area : null,
      name: NAMES[parseInt(id.slice(0, 2), 16) % NAMES.length] + ' ' + id.slice(-4),
      device: ['phone', 'tablet', 'computer'].includes(body.device) ? body.device : 'computer',
      stream: null,
      seen: now(),
      signals: 0,
      window: now()
    };
    // No await between allocation and reservation: concurrent joins cannot claim the same code.
    remember(s);
    codes.add(id.slice(-4));
    tokens.add(s.token);
    return reply(res, 200, { id, token: s.token, name: s.name, room: code, nearby: !!s.network, iceServers: iceServers(id) });
  }

  const EVENT_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

  /**
   * A stream for a client whose network holds a long response back: the same
   * events, queued and handed over in short requests. It stands in for a
   * response wherever one is written to (`write`, `end`, `destroy`,
   * `destroyed`, `writableLength`), and `collect` takes each request.
   *
   * A request is answered as soon as there is something to say, or after
   * `poll.wait` with nothing, and the client asks again at once. A newer
   * request supersedes one still waiting, which the client has given up on,
   * so nothing queued is handed to a request nobody reads. With no request for
   * `poll.gap` after an answer the client is gone, and `onClose` runs, as a
   * response's close would.
   */
  function pollStream(onClose) {
    let queue = '', waiting = null, wait = null, gap = null, due = false;
    const later = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; };
    const answer = () => {
      due = false;
      if (!waiting) return;
      const res = waiting, body = queue;
      waiting = null; queue = ''; clearTimeout(wait);
      res.writeHead(200, EVENT_HEADERS);
      res.end(body);
      if (!stream.destroyed) gap = later(() => stream.destroy(), poll.gap);
    };
    /* Everything written in one turn goes in one answer. */
    const soon = () => { if (waiting && !due) { due = true; queueMicrotask(answer); } };
    const finish = () => {
      if (stream.destroyed) return;
      stream.destroyed = true; clearTimeout(gap);
      answer();
      onClose();
    };
    const stream = {
      destroyed: false,
      get writableLength() { return queue.length; },
      write(text) { if (!stream.destroyed) { queue += text; soon(); } },
      end: finish,
      destroy: finish,
      collect(res) {
        clearTimeout(gap); clearTimeout(wait);
        if (waiting) { waiting.writeHead(200, EVENT_HEADERS); waiting.end(); }
        waiting = res;
        res.on('close', () => { if (waiting === res) { waiting = null; clearTimeout(wait); gap = later(() => stream.destroy(), poll.gap); } });
        if (queue) soon();
        else wait = later(answer, poll.wait);
      }
    };
    return stream;
  }

  /**
   * GET /api/share/events: the session's server-sent event stream.
   *
   * Opening it places the session on the network it is on now, publishes it
   * to its room and network, and tells it whether it is nearby and who is
   * already there. A reconnect supersedes the previous stream, and anyone the
   * move took the session away from hears that it left. Closing it marks the
   * session absent but does not delete it: a reload should not lose the
   * session, so collection is left to the sweep.
   *
   * With `poll=1` the same events are collected in short requests instead
   * (see `pollStream`), and a request while that is under way continues it,
   * unless it comes from somewhere else, which starts over as a new stream
   * would.
   */
  function events(req, res, s, url) {
    const collecting = url.searchParams.get('poll') === '1', area = areaOf(locate(req));
    if (collecting && s.stream?.collect && !s.stream.destroyed && area === s.area) return s.stream.collect(res);
    const before = s.stream ? neighbours(s) : null;
    relocate(s, area);
    if (before) for (const p of before) if (!related(s, p)) send(p, 'left', { id: s.id });
    if (s.stream) s.stream.end();
    /* Ignore the close of a stream this session has already replaced. */
    const closed = () => {
      if (s.stream !== stream) return;
      s.stream = null;
      s.seen = now();
      broadcast(s, 'left', { id: s.id });
    };
    const stream = collecting ? pollStream(closed) : res;
    s.stream = stream;
    if (collecting) stream.collect(res);
    else {
      res.writeHead(200, EVENT_HEADERS);
      res.flushHeaders();
      res.on('close', closed);
    }
    send(s, 'here', { nearby: !!s.network });
    send(s, 'peers', peers(s).map(publicPeer));
    broadcast(s, 'joined', publicPeer(s));
  }

  /**
   * POST /api/share/signal: relay one WebRTC message to a peer in the room.
   *
   * The payload is validated for shape and size but never interpreted: this
   * service does not need to understand an SDP to pass it along, and refusing to
   * parse one is the safest thing it can do with it. Both parties must share a
   * room or a network and be actively streaming, which is what stops the
   * endpoint from being a general-purpose message relay between strangers.
   */
  async function signal(req, res, s) {
    if (now() - s.window > RATE_WINDOW_MS) { s.signals = 0; s.window = now(); }
    if (++s.signals > MAX_SIGNALS_PER_WINDOW) return reply(res, 429, { error: 'too many connection messages' });

    const body = await readBody(req), target = sessions.get(body.to);
    if (!s.stream || !target?.stream || !related(s, target) || target.id === s.id) {
      return reply(res, 404, { error: 'that device left; ask them to reopen share' });
    }

    const message = body.signal;
    if (!message || typeof message !== 'object' || !/^[a-f0-9]{24}$/.test(message.connection || '')) {
      return reply(res, 400, { error: 'invalid connection message' });
    }
    const desc = message.description, candidate = message.candidate;
    if (desc) {
      if (!['offer', 'answer'].includes(desc.type) || typeof desc.sdp !== 'string' || desc.sdp.length > MAX_SDP_LENGTH) {
        return reply(res, 400, { error: 'invalid connection description' });
      }
    } else if (!candidate || typeof candidate.candidate !== 'string' || candidate.candidate.length > MAX_CANDIDATE_LENGTH) {
      return reply(res, 400, { error: 'invalid connection candidate' });
    }

    send(target, 'signal', { from: s.id, signal: message });
    return reply(res, 200, {});
  }

  /* ── dispatch ────────────────────────────────────────── */

  async function handle(req, res, url) {
    /* Browser requests must stay on this origin, or come from one the operator
       listed. Only a listed origin gets CORS headers, answered on every
       response, the preflight included, and varied on so no cache mixes them. */
    const cross = allowedCrossOrigin(req);
    if (!cross && !sameOrigin(req)) return reply(res, 403, { error: 'use share on this website' });
    if (cross) {
      res.setHeader('Access-Control-Allow-Origin', cross);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600', 'Cache-Control': 'no-store' });
        return res.end();
      }
    }

    if (url.pathname === '/api/share/join' && req.method === 'POST') return join(req, res, locate(req));

    /* Everything past this point needs a session. The token is compared in
       constant time, after a length check, so neither its value nor its length
       leaks through timing. */
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const s = sessions.get(url.searchParams.get('id'));
    if (!s || Buffer.byteLength(token) !== Buffer.byteLength(s.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(s.token))) {
      return reply(res, 401, { error: 'session expired' });
    }
    s.seen = now();

    if (url.pathname === '/api/share/events' && req.method === 'GET') return events(req, res, s, url);
    if (url.pathname === '/api/share/leave' && req.method === 'POST') { remove(s); return reply(res, 200, {}); }
    if (url.pathname === '/api/share/signal' && req.method === 'POST') return signal(req, res, s);
    reply(res, 404, { error: 'unknown share endpoint' });
  }

  return {
    /**
     * Handle one share request. Every failure below a deliberate 503 collapses
     * into a generic 400: the caller learns that the request was rejected, not
     * which check rejected it.
     */
    async handle(req, res, url) {
      try { await handle(req, res, url); }
      catch (error) {
        if (!res.headersSent && !res.destroyed) {
          reply(res, error.status === 503 ? 503 : 400, { error: error.status === 503 ? error.message : 'invalid share request' });
        }
      }
    },
    /** Stop sweeping and close every stream, so shutdown tells peers rather than
     *  leaving them to time out. */
    close() {
      clearInterval(sweep);
      for (const s of sessions.values()) remove(s);
    }
  };
}
