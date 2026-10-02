/* 𓁹𓁹 — share discovery and WebRTC signaling.
 *
 * File bytes never pass through this service. It does three things and nothing
 * else: it tells two browsers that they are in the same place, it relays the
 * handshake they need to open a direct connection, and it gets out of the way.
 * Once the peer connection is up, the transfer is browser to browser.
 *
 * The model
 *
 *   A *session* is one open share tab. It holds an id, a bearer token, a room,
 *   a display name, and — while the tab is open — a server-sent event stream.
 *
 *   A *room* is a hashed string that decides who can see whom. A session joins
 *   the room its link names, or, with no link, the room named by its own id,
 *   which it hands back as the link to pass on. That is the whole of the room
 *   bookkeeping: a room exists while someone is in it, its code is unique
 *   because session ids are, and a link reaches nobody once the tab that
 *   minted it has gone.
 *
 *   A *network* is the second way to meet, as ShareDrop did it: sessions that
 *   arrive from one public network — one IPv4 address, or one IPv6 /64 — see
 *   each other too, link or not. It is only used when the address is the
 *   visitor's own; a loopback, private or proxy address leaves the session to
 *   its link alone. It misses whenever Private Relay, a VPN or IPv6 on one
 *   device makes one network look like two, which is why the link stays.
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
 *   `CF-Connecting-IP`, or when no proxy header is present at all; anything
 *   ambiguous is counted against the proxy's own address instead. The same
 *   rule decides whether the address may group visitors into a network, with
 *   one more condition: it must be public, because a loopback or private
 *   address belongs to a proxy or a LAN and would put strangers together.
 *   A network holds no more sessions than a room; past that, newcomers meet
 *   by link alone.
 *
 *   Requests must be same-origin, or come from an origin the operator has
 *   listed in `SHARE_ALLOWED_ORIGINS` — the desktop app's, which serves its
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
   alone — enough for a real offer, far short of useful as a message channel. */
const MAX_SDP_LENGTH = 60000;
const MAX_CANDIDATE_LENGTH = 4096;

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
/* Any of these means a proxy sits in front, so the socket address is the
   proxy's, shared by every visitor behind it. */
const PROXY_HEADERS = ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded'];

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
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`, what a dual-stack socket reports for an
 * IPv4 client) is reduced to the plain IPv4 address so both spellings of one
 * client agree.
 *
 * @param {string} ip A valid IP address.
 * @returns {string} A stable network identifier.
 */
export function networkOf(ip) {
  const family = isIP(ip);
  if (family !== 6) return ip;
  const groups = expandIPv6(ip);
  return mappedIPv4(groups) || groups.slice(0, 4).map(group => group.toString(16)).join(':') + '::/64';
}

/** The IPv4 address an IPv4-mapped IPv6 address carries, or null. */
function mappedIPv4(groups) {
  const mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  return mapped ? [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.') : null;
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
    v4 = mappedIPv4(groups);
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
 * @param {string} [options.turnSecret] Shared secret for time-limited TURN
 *   credentials. Never leaves the process; only the derived HMAC is sent.
 * @param {string} [options.turnUrls] Comma-separated TURN URLs.
 * @param {string} [options.allowedOrigins] Comma-separated origins, besides
 *   this site's own, whose pages may use the service, such as the desktop app's
 *   `tauri://localhost` and `http://tauri.localhost`. Empty by default.
 * @param {() => number} [options.now] Clock, injected for tests.
 * @param {(n: number) => Buffer} [options.random] Entropy, injected for tests.
 * @returns {{handle: Function, close: Function}}
 */
export function createShareService({ trustCloudflare = process.env.SHARE_TRUST_CLOUDFLARE === '1', turnSecret = process.env.SHARE_TURN_SECRET, turnUrls = process.env.SHARE_TURN_URLS, allowedOrigins = process.env.SHARE_ALLOWED_ORIGINS, now = Date.now, random = randomBytes } = {}) {
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
  const crossOrigins = new Set(allowedOrigins ? allowedOrigins.split(',').map(v => v.trim()).filter(Boolean) : []);

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
   * left, and close its stream. Guarded so a stale reference — a delayed close
   * for a session whose id has since been reused — cannot remove a live one.
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
   * Only a plain object is accepted — an array or a bare value is not a message.
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
   * configured a relay, and then with an ephemeral credential — a username that
   * expires in an hour and an HMAC of it — so the shared secret never reaches
   * the browser.
   */
  function iceServers(id) {
    const servers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
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
   * Behind a trusted Cloudflare proxy the address is the visitor's; otherwise
   * it is the socket address, which may be the proxy's and so shared by
   * everyone behind it. That is fine for a rate limit, which then only counts
   * too many people together, but not for grouping, which would put them all
   * in one network. So a network is known only from the trusted header, or
   * from a request that carries no proxy header at all — and never from a
   * loopback or private address, which is a proxy's or a LAN's.
   */
  function locate(req) {
    const address = req.socket.remoteAddress || '';
    const forwarded = req.headers['cf-connecting-ip'];
    const loopback = LOOPBACK.includes(address);
    const trusted = trustCloudflare && loopback && typeof forwarded === 'string' && isIP(forwarded);
    const ip = trusted ? forwarded : address;
    const own = trustCloudflare ? !!trusted : !PROXY_HEADERS.some(name => req.headers[name] !== undefined);
    return { ip, networkKnown: own && !isLocalAddress(ip) };
  }

  /** The request's origin if the operator allows it cross-origin, else null. */
  function allowedCrossOrigin(req) {
    const origin = req.headers.origin;
    return typeof origin === 'string' && crossOrigins.has(origin) ? origin : null;
  }

  /** Whether the request came from this site rather than another origin. */
  function sameOrigin(req) {
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; }
    catch { return false; }
  }

  /* ── endpoints ───────────────────────────────────────── */

  /**
   * POST /api/share/join — create a session and return its credentials.
   *
   * With a room, the session joins it; without one, it joins the room its own
   * id names and hands that id back as the link to pass on. Either way it also
   * joins its network, when that is known and not already full.
   *
   * Rate limited per address. The id, its visible four-character short code and
   * the bearer token are all allocated and reserved without an await in between,
   * so two concurrent joins cannot be handed the same one.
   */
  async function join(req, res, { ip, networkKnown }) {
    /* Rate limit per network: an IPv6 client can otherwise rotate through the
       2^64 addresses in its own /64 and never hit the limit. */
    const network = networkOf(ip);
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
    const area = networkKnown ? key('network:' + network) : null;

    const s = {
      id,
      token: allocate(32, value => tokens.has(value)),
      room,
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

  /**
   * GET /api/share/events — the session's server-sent event stream.
   *
   * Opening it publishes the session to its room and network and hands back
   * the peers already there. A reconnect supersedes the previous stream.
   * Closing it marks the session absent but does not delete it: a reload
   * should not lose the session, so collection is left to the sweep.
   */
  function events(res, s) {
    if (s.stream) s.stream.end();
    s.stream = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    res.flushHeaders();
    send(s, 'peers', peers(s).map(publicPeer));
    broadcast(s, 'joined', publicPeer(s));
    res.on('close', () => {
      /* Ignore the close of a stream this session has already replaced. */
      if (s.stream !== res) return;
      s.stream = null;
      s.seen = now();
      broadcast(s, 'left', { id: s.id });
    });
  }

  /**
   * POST /api/share/signal — relay one WebRTC message to a peer in the room.
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

    if (url.pathname === '/api/share/events' && req.method === 'GET') return events(res, s);
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
