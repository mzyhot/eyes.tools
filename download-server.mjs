/* 𓁹𓁹: the downloader's server half.
 *
 * A browser cannot read a video site's pages from another origin, and most
 * sites hand out media addresses that only work from the address that asked
 * for them, so finding and fetching the media happens here, with yt-dlp. What
 * happens to it afterwards is the visitor's choice, as cobalt's local
 * processing does it:
 *
 *   On the device. The server looks the link up once (`probe`), keeps what
 *   yt-dlp found for an hour, and passes each stream to the browser as it
 *   arrives (`stream`), untouched. Joining a video stream to its sound, or
 *   taking the sound out of a video, happens in the browser (codecs/mux.js),
 *   and the finished file never exists on the server. A stream that needs no
 *   joining goes straight to the browser's own downloads.
 *
 *   On the server, when the device cannot (a stream cut into fragments, a
 *   conversion to mp3, a browser that runs out of memory) or the visitor asks.
 *   yt-dlp downloads and joins the streams into the job's own folder
 *   (`process`), the page polls for progress, and the finished file is sent
 *   once it is ready (`file`). It is deleted with the job, within the hour,
 *   or as soon as the visitor stops.
 *
 * What is deliberately defensive
 *
 *   yt-dlp fetches whatever an extractor tells it to, and an extractor can be
 *   told by whoever wrote the page it reads. So every request it makes goes
 *   through a proxy this process runs on loopback, with a credential only
 *   yt-dlp is given, and the proxy connects only to public addresses on ports
 *   80 and 443, checking every address a name resolves to and connecting to
 *   the one it checked. Loopback, private, link-local, carrier-grade NAT and
 *   reserved addresses (this machine, its LAN, a tailnet) are never reached.
 *   yt-dlp's generic extractor, which would read any page at all, is off.
 *
 *   yt-dlp runs as another user when the operator names one, because this
 *   process may run as root; its children are killed with it, as a group.
 *
 *   Nothing here relays an arbitrary address: a stream link names a job and
 *   a stream yt-dlp found, needs the job's token, compared in constant time,
 *   and works a few times only, so it is no mirror. Requests must be
 *   same-origin, or from an origin listed in `DOWNLOAD_ALLOWED_ORIGINS` (the
 *   desktop app's), so another site cannot spend this server on its visitors.
 *
 *   Lookups are rate limited per visitor network, counted as share counts
 *   them, and yt-dlp processes are capped per network and in all. Videos over
 *   three hours, live streams and files past 4 GB are refused. Jobs live an
 *   hour; their folders are deleted with them, and at startup.
 *
 *   Failures reach the visitor as one short sentence from yt-dlp's own error,
 *   about the link they gave. Nothing is logged: not the link, not the visitor.
 *
 * Off unless `DOWNLOAD_YTDLP` names the yt-dlp to run.
 */

import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream, mkdirSync, readdirSync, rmSync } from "node:fs";
import { chown, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { BlockList, connect, isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { originPolicy } from "./request-origin.mjs";
import { networkOf } from "./share-server.mjs";

/* A job, its stream links and its file all last this long. */
const JOB_MS = 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const PROBE_MS = 90 * 1000;
const FETCH_MS = 30 * 60 * 1000;
const MAX_JOBS = 200;
const MAX_PROCESSES = 8;
const MAX_NETWORK_PROCESSES = 3;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_PROBES_PER_WINDOW = 30;
const MAX_RATE_KEYS = 10000;
/* Each stream link and each finished file can be read this many times: enough
   for a retry, too few to serve as a mirror. */
const MAX_READS = 4;
const MAX_BODY_BYTES = 8192;
const MAX_URL_LENGTH = 2048;
/* What yt-dlp prints for one video; a long YouTube description and its
   formats come to a few megabytes. */
const MAX_INFO_BYTES = 32 * 1024 * 1024;
const MAX_ERROR_BYTES = 65536;
const MAX_DURATION_S = 3 * 60 * 60;
const MAX_BYTES = 4 * 1024 ** 3;
/* What a browser is asked to hold and join; past this the server joins. */
const LOCAL_MAX_BYTES = 1024 ** 3;
const QUALITIES = ["best", "2160", "1440", "1080", "720", "480", "360"];
const ID = /^[a-f0-9]{24}$/;

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/* Addresses the proxy never connects to: this machine, private networks,
   carrier-grade NAT (a tailnet), link-local, documentation, benchmarking,
   multicast, reserved, and the IPv6 forms that carry an IPv4 address inside
   them (mapped, compatible, NAT64, 6to4, Teredo), which could carry any of
   those. One list per family: a BlockList checks an IPv4 address against
   IPv6 rules too, as if mapped, so the IPv6 ranges that hold every IPv4
   address must not meet one. */
const BLOCKED = { ipv4: new BlockList(), ipv6: new BlockList() };
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]]) BLOCKED.ipv4.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64],
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]]) BLOCKED.ipv6.addSubnet(network, prefix, "ipv6");

/**
 * Whether the proxy may connect to an address: an IP address outside every
 * range in BLOCKED. Anything that is not an address is refused.
 * @param {string} ip
 * @returns {boolean}
 */
export function isPublicAddress(ip) {
  const family = isIP(ip) === 6 ? "ipv6" : isIP(ip) === 4 ? "ipv4" : null;
  if (!family) return false;
  try { return !BLOCKED[family].check(ip, family); }
  catch { return false; }
}

/* The types a stream or a file is sent as, by the extension yt-dlp gave it. */
const TYPES = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  m4a: "audio/mp4", mp3: "audio/mpeg", opus: "audio/ogg", ogg: "audio/ogg", oga: "audio/ogg", weba: "audio/webm",
  flac: "audio/flac", wav: "audio/wav", aac: "audio/aac"
};
const typeOf = ext => TYPES[ext] || "application/octet-stream";

/**
 * A codec as yt-dlp names it, reduced to the family that decides a container,
 * or null for none or unknown.
 * @param {string|null|undefined} codec Such as `avc1.64002A` or `mp4a.40.2`.
 */
export function codecFamily(codec) {
  const c = String(codec || "").toLowerCase();
  if (!c || c === "none") return null;
  for (const [pattern, family] of [[/^(avc|h\.?264)/, "avc"], [/^(hev|hvc|h\.?265)/, "hevc"], [/^vp0?9/, "vp9"], [/^vp0?8/, "vp8"],
    [/^(av01|av1)/, "av1"], [/^(mp3|mp4a\.(6b|69))/, "mp3"], [/^(mp4a|aac)/, "aac"], [/^opus/, "opus"], [/^vorbis/, "vorbis"],
    [/^flac/, "flac"], [/^(ac-3|ac3)/, "ac3"], [/^(ec-3|eac3)/, "eac3"]]) if (pattern.test(c)) return family;
  return "other";
}

/* yt-dlp writes "none" for a track a format lacks and leaves the codec out
   when it does not know it; then a format that names a size carries video,
   and one not marked silent may carry sound. */
const carriesVideo = f => f.vcodec ? f.vcodec !== "none" : f.video_ext ? f.video_ext !== "none" : !!(f.width || f.height);
const carriesAudio = f => f.acodec ? f.acodec !== "none" : f.audio_ext !== "none";

/**
 * The container a joined file goes in, chosen from its codecs as yt-dlp's
 * own `mp4/webm/mkv` would: webm for the open codecs, mp4 where it plays
 * almost everywhere, Matroska for the rest. Sound alone keeps its own kind
 * of file. Null when a codec is unknown, so the server decides.
 * @param {string|null} video Codec family, or null for no video.
 * @param {string|null} audio Codec family, or null for no sound.
 * @returns {{container: string, ext: string}|null}
 */
export function containerFor(video, audio) {
  if (video === "other" || audio === "other") return null;
  if (video) {
    if (["vp8", "vp9", "av1"].includes(video) && (!audio || audio === "opus" || audio === "vorbis")) return { container: "webm", ext: "webm" };
    if (["avc", "hevc", "vp9", "av1"].includes(video) && (!audio || ["aac", "mp3", "opus", "flac", "ac3", "eac3"].includes(audio))) return { container: "mp4", ext: "mp4" };
    return { container: "mkv", ext: "mkv" };
  }
  return { aac: { container: "mp4", ext: "m4a" }, mp3: { container: "mp3", ext: "mp3" }, opus: { container: "ogg", ext: "opus" },
    vorbis: { container: "ogg", ext: "ogg" } }[audio] || null;
}

/**
 * What the browser can do with what yt-dlp chose, or null when only the
 * server can finish it.
 *
 * The browser gets each stream whole, can copy tracks between files and can
 * make an mp3, but it cannot reassemble a stream cut into fragments. A single
 * stream already in its final form needs no joining at all and goes to the
 * browser's own downloads.
 * @param {object} info One video's info, as `yt-dlp -J` prints it.
 * @param {"video"|"audio"} mode
 * @param {"original"|"mp3"} audioFormat
 * @returns {object|null} `{ process, video, container, ext, streams: [{ type, size }] }`.
 */
export function planLocal(info, mode, audioFormat) {
  const formats = info.requested_formats || [info];
  if (!formats.length || !formats.every(f => /^https?$/.test(f.protocol || "") && !f.fragments && f.format_id)) return null;
  const sizes = formats.map(f => f.filesize || f.filesize_approx || null);
  if (sizes.reduce((sum, size) => sum + (size || 0), 0) > LOCAL_MAX_BYTES) return null;
  const streams = formats.map((f, at) => ({ type: typeOf(f.ext), size: sizes[at] }));
  const single = formats[0];
  const mp3 = mode === "audio" && audioFormat === "mp3";
  const whole = formats.length === 1 && !/_dash$/.test(single.container || "") && !(mode === "audio" && carriesVideo(single)) &&
    !(mp3 && codecFamily(single.acodec) !== "mp3");
  if (whole) return { process: false, video: mode === "video", container: null, ext: single.ext || "mp4", streams };
  const video = mode === "video" ? formats.find(carriesVideo) || null : null;
  const audio = formats.find(f => f !== video && carriesAudio(f)) || (video && carriesAudio(video) ? video : null);
  if (!video && !audio) return null;
  if (mp3) return { process: true, video: false, container: "mp3", ext: "mp3", streams };
  const chosen = containerFor(video ? codecFamily(video.vcodec) || "other" : null, audio ? codecFamily(audio.acodec) || "other" : null);
  if (!chosen) return null;
  return { process: true, video: !!video, ...chosen, streams };
}

/**
 * The format choice for yt-dlp: the best video no taller than the quality
 * asked for, with its sound, preferring the codecs that play everywhere (h264
 * and aac) at any one size; or the best sound alone, preferring aac.
 */
function selection(mode, quality) {
  if (mode === "audio") return ["-f", "ba/b", "-S", "+acodec:m4a"];
  return ["-f", "bv*+ba/b", "-S", (quality === "best" ? "res" : "res:" + quality) + ",+codec:avc:m4a"];
}

/** A safe filename stem from a title, or "video": no separators, controls or
    direction overrides, and no dots or spaces at either end, which Windows refuses. */
export function fileStem(title) {
  const stem = String(title || "").normalize("NFC")
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ");
  return [...stem.replace(/^[.\s]+/, "")].slice(0, 120).join("").replace(/[.\s]+$/, "") || "video";
}

/** A Content-Disposition that saves under a name, with an ASCII fallback. */
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * yt-dlp's last error as one short sentence about the link, in the site's
 * lowercase voice. The common failures get plain words; the rest keep
 * yt-dlp's own first sentence, without its advice about command-line flags.
 * @param {string} stderr
 * @returns {string}
 */
export function explain(stderr) {
  const line = String(stderr).split("\n").reverse().find(l => l.startsWith("ERROR:")) || "";
  const text = line.replace(/^ERROR:\s*(\[[^\]]*\]\s*)?([^\s:]+:\s+)?/, "").trim();
  const known = [
    [/unsupported url|no suitable extractor/i, "this site is not supported"],
    /* The proxy's refusal, as yt-dlp's two HTTP clients report it. */
    [/tunnel connection failed: 403|connect tunnel failed, response 403/i, "that address cannot be reached from here"],
    [/not a bot|too many requests|rate.?limit|http error 429|data cent(er|re) ip|ip may be blocked/i, "the site is refusing the server right now; try again later"],
    [/private video|this video is private|is private/i, "this video is private"],
    [/confirm your age|age.?restrict|inappropriate for some users/i, "this video is age-restricted"],
    [/log ?in|sign ?in|logged.in|authenticat|cookies|account/i, "this video needs an account to watch"],
    [/not available in your country|geo.?restrict|not available from your location/i, "this video is not available where the server is"],
    [/no video|no media|there'?s no video|does not contain/i, "there is no video at that link"],
    [/unavailable|not found|http error 404|does not exist|has been removed|deleted/i, "this video is unavailable"],
    [/requested format is not available/i, "that quality is not available for this video"]
  ];
  for (const [pattern, message] of known) if (pattern.test(text)) return message;
  const sentence = text.split(/(?<=\.)\s+/)[0].replace(/\s*\(caused by .*$/i, "").slice(0, 200);
  return sentence ? sentence.charAt(0).toLowerCase() + sentence.slice(1).replace(/\.$/, "") : "the server could not get this video";
}

/**
 * The loopback proxy every yt-dlp request goes through. CONNECT for https,
 * absolute-form requests for plain http, both only with the credential this
 * process hands yt-dlp, and both only to public addresses on 80 or 443.
 * @param {(name: string) => Promise<{address: string}[]>} resolve Name lookup, injected for tests.
 */
function createEgress(resolve) {
  const user = randomBytes(12).toString("hex"), pass = randomBytes(24).toString("hex");
  const expected = Buffer.from("Basic " + Buffer.from(user + ":" + pass).toString("base64"));
  const sockets = new Set();
  const authorized = req => {
    const given = Buffer.from(String(req.headers["proxy-authorization"] || ""));
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  /* The address to connect to, checked: every address the name has must be
     public, so a name cannot pair a public address with a private one. */
  async function destination(host, port) {
    if (port !== 80 && port !== 443) throw new Error("port");
    const name = host.replace(/^\[(.*)\]$/, "$1");
    const found = isIP(name) ? [{ address: name }] : await resolve(name);
    if (!found.length || !found.every(entry => isPublicAddress(entry.address))) throw new Error("address");
    return found[0].address;
  }
  const HOP = ["connection", "keep-alive", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];
  const strip = headers => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.includes(name)));

  const server = createServer(async (req, res) => {
    if (!authorized(req)) { res.writeHead(407, { "Proxy-Authenticate": "Basic" }); return res.end(); }
    let url, address;
    try {
      url = new URL(req.url);
      if (url.protocol !== "http:") throw new Error("scheme");
      address = await destination(url.hostname, Number(url.port || 80));
    } catch { res.writeHead(403); return res.end(); }
    const upstream = httpRequest({ host: address, port: Number(url.port || 80), method: req.method, path: url.pathname + url.search,
      headers: { ...strip(req.headers), host: url.host }, setHost: false }, answer => {
      res.writeHead(answer.statusCode || 502, strip(answer.headers));
      answer.pipe(res);
    });
    upstream.setTimeout(60000, () => upstream.destroy());
    upstream.on("error", () => { if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy(); });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("connect", async (req, client, head) => {
    client.on("error", () => {});
    if (!authorized(req)) return client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
    const target = /^(\[[0-9a-fA-F:.]+\]|[^:\s]+):(\d{1,5})$/.exec(req.url || "");
    let address;
    try { if (!target) throw new Error("target"); address = await destination(target[1], Number(target[2])); }
    catch { return client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); }
    const upstream = connect({ host: address, port: Number(target[2]) });
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.setTimeout(300000, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(`http://${user}:${pass}@127.0.0.1:${server.address().port}`));
  });
  ready.catch(() => {});
  return { ready, close() { server.close(); for (const socket of sockets) socket.destroy(); } };
}

/**
 * Build the download service.
 *
 * @param {object} [options]
 * @param {string|string[]} [options.ytdlp] The yt-dlp to run, as a path, or a
 *   command and its first arguments. Unset turns the service off.
 * @param {string} [options.dir] Where jobs keep their files; a folder of the
 *   system's temporary directory unless set.
 * @param {number} [options.uid] User to run yt-dlp as, when this process can.
 * @param {number} [options.gid] Group to run yt-dlp as.
 * @param {boolean} [options.trustCloudflare] As share's: believe
 *   `CF-Connecting-IP` from loopback when counting a visitor's lookups.
 * @param {string} [options.allowedOrigins] Comma-separated origins, besides
 *   this site's own, whose pages may use the service.
 * @param {(name: string) => Promise<{address: string}[]>} [options.resolve]
 *   Name lookup for the proxy, injected for tests.
 * @param {() => number} [options.now] Clock, injected for tests.
 * @returns {{handle: Function, close: Function}}
 */
export function createDownloadService({
  ytdlp = process.env.DOWNLOAD_YTDLP,
  dir = process.env.DOWNLOAD_DIR || join(tmpdir(), "eyes-downloads"),
  uid = process.env.DOWNLOAD_UID ? Number(process.env.DOWNLOAD_UID) : undefined,
  gid = process.env.DOWNLOAD_GID ? Number(process.env.DOWNLOAD_GID) : undefined,
  trustCloudflare = process.env.SHARE_TRUST_CLOUDFLARE === "1",
  allowedOrigins = process.env.DOWNLOAD_ALLOWED_ORIGINS,
  resolve = name => lookup(name, { all: true, verbatim: true }),
  now = Date.now
} = {}) {
  const { allowedCrossOrigin, sameOrigin } = originPolicy(allowedOrigins);
  const command = ytdlp ? (Array.isArray(ytdlp) ? ytdlp : [ytdlp]) : null;
  /** @type {Map<string, object>} job id → job */
  const jobs = new Map();
  /** @type {Map<string, {count: number, start: number}>} hashed network → lookups */
  const rates = new Map();
  /** @type {Map<string, number>} hashed network → yt-dlp processes running */
  const running = new Map();
  const children = new Set();
  const salt = randomBytes(32);
  const key = value => createHmac("sha256", salt).update(value).digest("hex");
  let total = 0;

  const owned = uid !== undefined && gid !== undefined && Number.isInteger(uid) && Number.isInteger(gid);
  const cache = join(dir, "cache");
  let egress = null;
  if (command) {
    /* Folders left by a previous run belong to jobs nobody can reach now. */
    mkdirSync(dir, { recursive: true, mode: 0o711 });
    for (const name of readdirSync(dir)) if (ID.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    egress = createEgress(resolve);
  }
  const give = path => owned ? chown(path, uid, gid) : Promise.resolve();
  const ready = command ? give(cache).then(() => egress.ready) : null;
  ready?.catch(() => {});

  /* The environment yt-dlp runs in: its own folder first on the path, where
     a virtual environment keeps the JavaScript runtime it solves YouTube's
     challenges with, and a home it may write its caches to. */
  const env = command ? {
    PATH: [...(isAbsolute(command[0]) ? [dirname(command[0])] : []), ...String(process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":")].join(":"),
    HOME: cache, XDG_CACHE_HOME: cache, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1"
  } : null;

  /**
   * Start yt-dlp, counted against the visitor's network and the whole server.
   * @throws {Error} With status 429 or 503 when either is full.
   */
  async function ytdlpRun(network, args, timeout) {
    const proxy = await ready.catch(() => { throw status(503, "the server half of the downloader could not start"); });
    if (total >= MAX_PROCESSES) throw status(503, "the downloader is busy; try again in a minute");
    if ((running.get(network) || 0) >= MAX_NETWORK_PROCESSES) throw status(429, "finish a download before starting another");
    const child = spawn(command[0], [...command.slice(1), "--ignore-config", "--no-playlist", "--playlist-items", "1",
      "--use-extractors", "default,-generic", "--proxy", proxy, "--cache-dir", cache, "--socket-timeout", "20",
      "--retries", "3", "--fragment-retries", "3", "--no-warnings", ...args],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], detached: true, ...(owned ? { uid, gid } : {}) });
    total++;
    running.set(network, (running.get(network) || 0) + 1);
    children.add(child);
    let error = "";
    child.stderr.on("data", chunk => { if (error.length < MAX_ERROR_BYTES) error += chunk; });
    const timer = setTimeout(() => kill(child), timeout);
    child.done = new Promise(resolve => child.once("close", code => {
      clearTimeout(timer);
      children.delete(child);
      total--;
      const left = (running.get(network) || 1) - 1;
      if (left) running.set(network, left); else running.delete(network);
      resolve({ code, error });
    }));
    child.once("error", () => {});
    return child;
  }

  /** Kill a yt-dlp and whatever it started (ffmpeg, the JavaScript runtime). */
  function kill(child) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  }

  const status = (code, message) => Object.assign(new Error(message), { status: code });

  /** Send a JSON response. Never cached or sniffed. */
  function reply(res, code, body) {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    res.end(JSON.stringify(body));
  }

  async function readBody(req) {
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw status(400, "use application/json");
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw status(413, "that request is too large");
      chunks.push(chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || typeof body !== "object" || Array.isArray(body)) throw status(400, "invalid request");
    return body;
  }

  /** The visitor's network, hashed: their address behind a trusted proxy, else the socket's. */
  function locate(req) {
    const address = req.socket.remoteAddress || "";
    const forwarded = req.headers["cf-connecting-ip"];
    const trusted = trustCloudflare && LOOPBACK.includes(address) && typeof forwarded === "string" && isIP(forwarded);
    return key(networkOf(trusted ? forwarded : address));
  }

  /** A link the visitor gave, checked for shape; the proxy checks where it leads. */
  function checkLink(raw) {
    if (typeof raw !== "string" || !raw.trim()) throw status(400, "paste a link to a video");
    if (raw.length > MAX_URL_LENGTH) throw status(400, "that link is too long");
    /* A link copied from an address bar may have lost its scheme. */
    const text = raw.trim();
    let url;
    try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : "https://" + text); } catch { throw status(400, "that is not a link"); }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw status(400, "use an http or https link");
    if (url.username || url.password) throw status(400, "use a link without a name or password in it");
    if (url.port && url.port !== "80" && url.port !== "443") throw status(400, "that address cannot be reached from here");
    return url.href;
  }

  /** Everything a job's owner may see of it. */
  const view = job => ({ state: job.state, progress: job.progress, downloaded: job.downloaded, total: job.total,
    size: job.size, ext: job.ext, error: job.error });

  /** Delete a job and its folder, once anything still working for it is killed. */
  function drop(job) {
    jobs.delete(job.id);
    const working = [...job.children];
    for (const child of working) kill(child);
    Promise.all(working.map(child => child.done)).then(() => rm(job.dir, { recursive: true, force: true })).catch(() => {});
  }

  const sweep = setInterval(() => {
    const at = now();
    for (const job of jobs.values()) if (at - job.created > JOB_MS) drop(job);
    for (const [network, rate] of rates) if (at - rate.start > RATE_WINDOW_MS) rates.delete(network);
  }, SWEEP_MS);
  sweep.unref();

  /* ── endpoints ───────────────────────────────────────── */

  /**
   * POST /api/download/probe: look a link up with yt-dlp and keep what it
   * found as a job. Answers the job's id and token, the title, and what the
   * browser can do with it (`local`), or null when only the server can.
   */
  async function probe(req, res, network) {
    const rate = rates.get(network) || { count: 0, start: now() };
    if (now() - rate.start > RATE_WINDOW_MS) { rate.count = 0; rate.start = now(); }
    if (rates.size >= MAX_RATE_KEYS && !rates.has(network)) throw status(503, "the downloader is busy; try again in a minute");
    rates.set(network, rate);
    if (++rate.count > MAX_PROBES_PER_WINDOW) throw status(429, "too many links at once; try again in a few minutes");

    const body = await readBody(req);
    const link = checkLink(body.url);
    const mode = body.mode === "audio" ? "audio" : "video";
    const quality = QUALITIES.includes(String(body.quality)) ? String(body.quality) : "1080";
    const audioFormat = body.audioFormat === "mp3" ? "mp3" : "original";
    if (jobs.size >= MAX_JOBS) throw status(503, "the downloader is busy; try again in a minute");

    const child = await ytdlpRun(network, [...selection(mode, quality), "-J", "--", link], PROBE_MS);
    const chunks = [];
    let size = 0;
    child.stdout.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_INFO_BYTES) kill(child); else chunks.push(chunk);
    });
    const abandon = () => kill(child);
    res.on("close", abandon);
    const { code, error } = await child.done;
    res.off("close", abandon);
    if (res.destroyed) return;
    let info = null;
    if (code === 0) { try { info = JSON.parse(Buffer.concat(chunks).toString()); } catch {} }
    if (info?._type === "playlist") info = info.entries?.find(Boolean) || null;
    if (!info) return reply(res, 422, { error: code === 0 ? "there is no video at that link" : explain(error) });
    if (info.is_live || info.live_status === "is_live" || info.live_status === "is_upcoming") return reply(res, 422, { error: "live streams are not supported" });
    if (info.duration > MAX_DURATION_S) return reply(res, 422, { error: "videos over three hours are not supported" });
    const known = (info.requested_formats || [info]).reduce((sum, f) => sum + (f.filesize || f.filesize_approx || 0), 0);
    if (known > MAX_BYTES) return reply(res, 422, { error: "that file is over 4 GB, too large to download here" });

    const id = randomBytes(12).toString("hex"), token = randomBytes(16).toString("hex");
    const job = { id, token, created: now(), dir: join(dir, id), info, mode, quality, audioFormat, local: planLocal(info, mode, audioFormat),
      filename: fileStem(info.title), state: "found", progress: null, downloaded: 0, total: null, size: null, ext: null, error: null,
      file: null, reads: new Map(), children: new Set() };
    await mkdir(job.dir, { mode: 0o700 });
    await give(job.dir);
    await writeFile(join(job.dir, "info.json"), JSON.stringify(info), { mode: 0o600 });
    await give(join(job.dir, "info.json"));
    jobs.set(id, job);
    reply(res, 200, { id, token, title: String(info.title || ""), site: String(info.extractor_key || info.extractor || ""),
      duration: Number(info.duration) || null, filename: job.filename, local: job.local });
  }

  /** Count one read of a stream link or a file, refusing past MAX_READS. */
  function read(job, what) {
    const count = (job.reads.get(what) || 0) + 1;
    if (count > MAX_READS) throw status(410, "this download link has been used up; start again");
    job.reads.set(what, count);
  }

  /**
   * GET /api/download/<id>/stream/<n>: one stream of a job, as yt-dlp fetches
   * it, passed on as it arrives. `save=1` sends it as a download, for a
   * stream that needs no joining.
   *
   * The answer waits for the first bytes, so a stream that fails at once is
   * an error the page can act on rather than an empty file.
   */
  async function stream(req, res, network, job, n, save) {
    const format = (job.info.requested_formats || [job.info])[n];
    if (!job.local || !format) throw status(404, "that stream is not part of this download");
    read(job, "stream" + n);
    const child = await ytdlpRun(network, ["--load-info-json", join(job.dir, "info.json"), "-f", String(format.format_id),
      "--max-filesize", String(MAX_BYTES), "--no-part", "--quiet", "-o", "-"], FETCH_MS);
    job.children.add(child);
    const abandon = () => kill(child);
    res.on("close", abandon);
    child.stdout.once("data", first => {
      const name = job.filename + "." + (format.ext || "mp4");
      res.writeHead(200, {
        "Content-Type": typeOf(format.ext), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        ...(format.filesize ? { "Content-Length": format.filesize } : {}), ...(save ? { "Content-Disposition": disposition(name) } : {})
      });
      res.write(first);
      child.stdout.pipe(res, { end: false });
    });
    const { code, error } = await child.done;
    job.children.delete(child);
    res.off("close", abandon);
    if (res.destroyed) return;
    if (!res.headersSent) return reply(res, 502, { error: explain(error) });
    /* A stream cut short ends the connection, not the body, so the browser
       sees a failure rather than a shorter file. */
    if (code === 0) res.end(); else res.destroy();
  }

  /**
   * POST /api/download/<id>/process: download and join the job on the
   * server, into its folder. Answers at once; progress comes from polling.
   */
  async function processJob(res, network, job) {
    if (job.state === "found" || job.state === "failed") {
      const args = ["--load-info-json", join(job.dir, "info.json"), ...selection(job.mode, job.quality), "-P", job.dir, "-o", "media.%(ext)s",
        "--max-filesize", String(MAX_BYTES), "--no-mtime", "--newline",
        "--progress-template", "download:[eyes] %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s",
        "--progress-template", "postprocess:[eyes] processing",
        ...(job.mode === "audio" ? ["-x", ...(job.audioFormat === "mp3" ? ["--audio-format", "mp3", "--audio-quality", "0"] : [])]
          : ["--merge-output-format", "mp4/webm/mkv"])];
      const child = await ytdlpRun(network, args, FETCH_MS);
      job.children.add(child);
      const formats = job.mode === "audio" ? [job.info] : (job.info.requested_formats || [job.info]);
      const sizes = formats.map(f => f.filesize || f.filesize_approx || 0);
      Object.assign(job, { state: "downloading", progress: 0, downloaded: 0, total: sizes.every(Boolean) ? sizes.reduce((a, b) => a + b, 0) : null, error: null });
      /* Each stream is its own download, reported from zero; the job's
         progress adds the ones finished to the one going. */
      let phase = -1, done = 0, current = 0, last = 0;
      let buffered = "";
      child.stdout.on("data", chunk => {
        buffered += chunk;
        const lines = buffered.split("\n");
        buffered = lines.pop();
        for (const line of lines) {
          if (line.startsWith("[download] Destination:")) { phase++; done += last; current = 0; last = 0; }
          const match = /^\[eyes\] (\S+) (\S+) (\S+)/.exec(line);
          if (line === "[eyes] processing") { job.state = "processing"; job.progress = 1; continue; }
          if (!match) continue;
          current = Number(match[1]) || 0;
          last = Number(match[2]) || Number(match[3]) || last;
          const at = Math.max(0, phase);
          job.downloaded = done + current;
          job.progress = Math.min(0.99, (at + (last ? Math.min(1, current / last) : 0)) / Math.max(formats.length, at + 1));
        }
      });
      child.done.then(async ({ code, error }) => {
        job.children.delete(child);
        if (!jobs.has(job.id)) return;
        const name = code === 0 ? (await readdir(job.dir).catch(() => [])).find(entry => /^media\.[a-z0-9]{1,5}$/.test(entry)) : null;
        if (!name) return Object.assign(job, { state: "failed", progress: null, error: code === 0 ? "the server could not finish this file" : explain(error) });
        const file = join(job.dir, name), info = await stat(file);
        Object.assign(job, { state: "ready", progress: 1, file, size: info.size, ext: name.slice(6), downloaded: info.size });
      });
    }
    reply(res, 202, view(job));
  }

  /** GET /api/download/<id>/file: the file the server made, once ready. */
  async function file(req, res, job) {
    if (job.state !== "ready" || !job.file) throw status(409, "that file is not ready yet");
    read(job, "file");
    res.writeHead(200, { "Content-Type": typeOf(job.ext), "Content-Length": job.size, "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Content-Disposition": disposition(job.filename + "." + job.ext) });
    if (req.method === "HEAD") return res.end();
    const body = createReadStream(job.file);
    body.on("error", () => res.destroy());
    res.on("close", () => body.destroy());
    body.pipe(res);
  }

  /* ── dispatch ────────────────────────────────────────── */

  async function handle(req, res, url) {
    const cross = allowedCrossOrigin(req);
    if (!cross && !sameOrigin(req)) return reply(res, 403, { error: "use the downloader on this website" });
    if (cross) {
      res.setHeader("Access-Control-Allow-Origin", cross);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, DELETE", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600", "Cache-Control": "no-store" });
        return res.end();
      }
    }
    if (!command) return reply(res, 503, { error: "the server half of the downloader is off here" });
    const network = locate(req);
    if (url.pathname === "/api/download/probe" && req.method === "POST") return probe(req, res, network);

    /* Everything else names a job and carries its token, compared in
       constant time after a length check. */
    const route = /^\/api\/download\/([a-f0-9]{24})(?:\/(stream)\/(\d)|\/(process|file))?$/.exec(url.pathname);
    const job = route && jobs.get(route[1]);
    const token = String(url.searchParams.get("t") || "");
    if (!job || Buffer.byteLength(token) !== Buffer.byteLength(job.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(job.token))) {
      return reply(res, 404, { error: "that download has expired; start again" });
    }
    const get = req.method === "GET" || req.method === "HEAD";
    if (route[2] === "stream" && get) return stream(req, res, network, job, Number(route[3]), url.searchParams.get("save") === "1");
    if (route[4] === "process" && req.method === "POST") return processJob(res, network, job);
    if (route[4] === "file" && get) return file(req, res, job);
    if (!route[2] && !route[4] && get) return reply(res, 200, view(job));
    /* A visitor who stops a download frees what it holds at once. */
    if (!route[2] && !route[4] && req.method === "DELETE") { drop(job); return reply(res, 200, {}); }
    reply(res, 405, { error: "unknown download endpoint" });
  }

  return {
    /** Handle one request. A failure without a status of its own is a 400. */
    async handle(req, res, url) {
      try { await handle(req, res, url); }
      catch (error) {
        if (!res.headersSent && !res.destroyed) reply(res, error.status || 400, { error: error.status ? error.message : "invalid download request" });
        else if (!res.writableEnded) res.destroy();
      }
    },
    /** Stop sweeping, kill every yt-dlp, close the proxy and delete the jobs. */
    close() {
      clearInterval(sweep);
      for (const job of [...jobs.values()]) drop(job);
      for (const child of children) kill(child);
      egress?.close();
    }
  };
}
