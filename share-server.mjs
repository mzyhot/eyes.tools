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
 *   A *room* is a hashed string that decides who can see whom. It comes from
 *   one of three places, in order of preference:
 *     · an explicit room link, so two people on different networks can meet;
 *     · the visitor's network address, so two tabs on one network find each
 *       other with no link at all;
 *     · the session's own id, which is a room of one — the correct fallback
 *       when the address is not trustworthy.
 *
 *   Nothing is persisted. Everything is in memory and dies with the process,
 *   which is the intended lifetime: discovery is ephemeral by design.
 *
 * What is deliberately defensive
 *
 *   Room keys are HMACs under a per-process salt, never raw addresses or raw
 *   link codes, so the in-memory state does not accumulate readable network
 *   identifiers and a leaked key reveals nothing and works nowhere else.
 *
 *   The address is only trusted as a room when the operator has said this
 *   process sits behind Cloudflare *and* the request arrived from loopback with
 *   a valid `CF-Connecting-IP`, or when no proxy header is present at all. A
 *   stripped, forged or untrusted proxy header must never put every unrelated
 *   visitor into one shared room, so anything ambiguous falls back to a room
 *   of one.
 *
 *   Requests must be same-origin, or come from an origin the operator has
 *   listed in `SHARE_ALLOWED_ORIGINS` — the desktop app's, which serves its
 *   pages itself and uses this service only for discovery and signaling. Only
 *   those origins get CORS headers, and the list is empty unless set, so a
 *   page on another domain cannot enumerate anyone.
 *
 *   Tokens are compared in constant time, every payload is size-capped before
 *   it is parsed, joins and signals are rate limited per address and per
 *   session, and rooms, sessions and streams all have hard ceilings.
 *
 * Bookkeeping
 *
 *   `sessions` is keyed by id. `roomMembers` indexes those same sessions by
 *   room, so finding someone's peers, counting a room, and listing the rooms in
 *   use are all proportional to the room rather than to everyone connected. The
 *   two must be updated together; `remember` and `forget` are the only places
 *   that do it.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/* Display names. Two words plus the session's short code, so a visitor can tell
   which device in the list is theirs without anything identifying appearing. */
const NAMES = ['quiet fox', 'silver heron', 'little owl', 'calm otter', 'swift finch', 'still deer', 'pale moth', 'soft lynx'];

/* A room link is idle-expired a day after the last session in it disconnects. */
const ROOM_IDLE_MS = 24 * 60 * 60 * 1000;
/* How often to sweep dead sessions and expired rooms, and to ping live streams. */
const SWEEP_MS = 15000;
/* A session with no stream is collected this long after it was last seen. */
const SESSION_GRACE_MS = 45000;
/* All rate limits use this window. */
const RATE_WINDOW_MS = 60000;
const MAX_JOINS_PER_WINDOW = 30;
const MAX_SIGNALS_PER_WINDOW = 1000;
const MAX_SESSIONS = 1000;
const MAX_ROOM_MEMBERS = 16;
const MAX_ROOMS = 1000;
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
/* Headers a reverse proxy adds to say who the visitor really is. Without trust,
   any of them means the socket address belongs to the proxy, shared by every
   visitor, so it must not be used as a network. */
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
 * IPv4 behind a home router is already shared: every device on the Wi-Fi
 * leaves through one public address, so the address *is* the network.
 *
 * IPv6 is not. Each device on the same Wi-Fi gets its own public address — and
 * usually rotates a temporary one besides — so grouping by the full address
 * puts two devices on one network into two different rooms. What they share is
 * the /64 prefix: the network half of the address, handed to the whole local
 * link by the router. Grouping by it gives IPv6 the same meaning IPv4 already
 * had. Mobile carriers assign each phone its own /64, so this does not group
 * strangers on cellular.
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
  if (family === 4) return ip;
  if (family !== 6) return ip;
  const groups = expandIPv6(ip);
  const mapped = groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
  if (mapped) return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  return groups.slice(0, 4).map(group => group.toString(16)).join(':') + '::/64';
}

/**
 * Build the share service.
 *
 * @param {object} [options]
 * @param {boolean} [options.trustCloudflare] Whether `CF-Connecting-IP` from
 *   loopback may be believed. Opt-in: wrong here means strangers share a room.
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
  /** @type {Map<string, {count: number, start: number}>} hashed address → joins */
  const rates = new Map();
  /** @type {Map<string, number>} room key → expiry, for links with nobody in them */
  const rooms = new Map();
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

  /* Rooms are addressed by HMAC, never by the address or link they came from. */
  const key = value => createHmac('sha256', salt).update(value).digest('hex');

  /* What one peer is allowed to learn about another: never the token, never the
     address, never the room. */
  const publicPeer = s => ({ id: s.id, name: s.name, device: s.device });

  /** Add a session to both indexes. */
  function remember(s) {
    sessions.set(s.id, s);
    let members = roomMembers.get(s.room);
    if (!members) { members = new Set(); roomMembers.set(s.room, members); }
    members.add(s);
  }

  /** Drop a session from both indexes, discarding the room once it is empty. */
  function forget(s) {
    sessions.delete(s.id);
    const members = roomMembers.get(s.room);
    if (members) {
      members.delete(s);
      if (!members.size) roomMembers.delete(s.room);
    }
  }

  /** How many sessions are in a room, without walking every session. */
  const roomSize = room => (roomMembers.get(room)?.size ?? 0);

  /** The connected peers a session may see: same room, not itself, streaming. */
  function peers(s) {
    const members = roomMembers.get(s.room);
    if (!members) return [];
    const out = [];
    for (const p of members) if (p !== s && p.stream) out.push(p);
    return out;
  }

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

  /** Send an event to everyone else in the room. */
  const broadcast = (s, type, data) => {
    const members = roomMembers.get(s.room);
    if (!members) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const p of members) {
      if (p === s || !p.stream || p.stream.destroyed) continue;
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
   *   · push out the expiry of rooms still in use and drop the rest;
   *   · forget rate-limit counters whose window has passed.
   */
  const sweep = setInterval(() => {
    const at = now();
    for (const s of sessions.values()) {
      if (!s.stream && at - s.seen > SESSION_GRACE_MS) remove(s);
      else if (s.stream) send(s, 'ping', {});
    }
    for (const [room, expires] of rooms) {
      if (roomMembers.has(room)) rooms.set(room, at + ROOM_IDLE_MS);
      else if (expires <= at) rooms.delete(room);
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
   * Decide which room a visitor belongs to, and whether their network is known.
   *
   * The second value is the important one. When the answer is "not known" the
   * caller must put the visitor in a room of one: a missing or stripped proxy
   * header would otherwise collapse every public visitor into a single room
   * where they could all see each other. Without trust, a request that shows
   * any sign of having passed through a proxy is treated the same way, since
   * its socket address is the proxy's.
   */
  function locate(req) {
    const address = req.socket.remoteAddress || '';
    const forwarded = req.headers['cf-connecting-ip'];
    const loopback = LOOPBACK.includes(address);
    const trustedVisitor = trustCloudflare && loopback && typeof forwarded === 'string' && isIP(forwarded);
    return {
      ip: trustedVisitor ? forwarded : address,
      networkKnown: trustCloudflare ? !!trustedVisitor : !PROXY_HEADERS.some(name => req.headers[name] !== undefined)
    };
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
    if (body.room !== undefined && !/^[a-f0-9]{32}$/.test(body.room)) return reply(res, 400, { error: 'this room link is invalid' });

    const id = allocate(12, value => sessions.has(value) || codes.has(value.slice(-4)));
    const room = body.room ? key('room:' + body.room) : networkKnown ? key('network:' + network) : key('alone:' + id);
    if (sessions.size >= MAX_SESSIONS || roomSize(room) >= MAX_ROOM_MEMBERS) {
      return reply(res, 429, { error: 'this room is full; try a new room link' });
    }

    const s = {
      id,
      token: allocate(32, value => tokens.has(value)),
      room,
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
    return reply(res, 200, { id, token: s.token, name: s.name, iceServers: iceServers(id), networkKnown: !!networkKnown });
  }

  /**
   * POST /api/share/room — mint a room link this session can pass to someone.
   *
   * Idempotent per session, so a double tap gives out one link. The link is
   * reserved the moment it is issued, before its creator has joined it, so the
   * same code cannot be handed to two people in the gap.
   */
  async function createRoom(req, res, s) {
    await readBody(req);
    /* The session may have been retired while its body was being read. */
    if (sessions.get(s.id) !== s) return reply(res, 401, { error: 'session expired' });
    if (s.createdRoom && rooms.has(key('room:' + s.createdRoom))) return reply(res, 200, { room: s.createdRoom });
    if (rooms.size >= MAX_ROOMS) return reply(res, 503, { error: 'share is busy; try again later' });
    /* Avoid both reserved links and rooms that already have people in them —
       the latter can exist without a reservation when the link predates it. */
    const code = allocate(16, value => {
      const roomKey = key('room:' + value);
      return rooms.has(roomKey) || roomMembers.has(roomKey);
    });
    // Reserve before returning the link, including before its creator joins it.
    rooms.set(key('room:' + code), now() + ROOM_IDLE_MS);
    s.createdRoom = code;
    return reply(res, 200, { room: code });
  }

  /**
   * GET /api/share/events — the session's server-sent event stream.
   *
   * Opening it publishes the session to the room and hands back the peers
   * already there. A reconnect supersedes the previous stream. Closing it marks
   * the session absent but does not delete it: a reload should not lose the
   * session, so collection is left to the sweep.
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
   * parse one is the safest thing it can do with it. Both parties must be in the
   * same room and actively streaming, which is what stops the endpoint from
   * being a general-purpose message relay between strangers.
   */
  async function signal(req, res, s) {
    if (now() - s.window > RATE_WINDOW_MS) { s.signals = 0; s.window = now(); }
    if (++s.signals > MAX_SIGNALS_PER_WINDOW) return reply(res, 429, { error: 'too many connection messages' });

    const body = await readBody(req), target = sessions.get(body.to);
    if (!s.stream || !target?.stream || target.room !== s.room || target.id === s.id) {
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

    const where = locate(req);
    if (url.pathname === '/api/share/join' && req.method === 'POST') return join(req, res, where);

    /* Everything past this point needs a session. The token is compared in
       constant time, after a length check, so neither its value nor its length
       leaks through timing. */
    const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const s = sessions.get(url.searchParams.get('id'));
    if (!s || Buffer.byteLength(token) !== Buffer.byteLength(s.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(s.token))) {
      return reply(res, 401, { error: 'session expired' });
    }
    s.seen = now();

    if (url.pathname === '/api/share/room' && req.method === 'POST') return createRoom(req, res, s);
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
