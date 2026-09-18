# 𓁹𓁹

**[Explore the codebase wiki →](https://github.com/mzyhot/eyes.tools/wiki)** — setup, tool catalog,
architecture, contributor guides, APIs, deployment, and troubleshooting.

A directory of small, mostly local tools. No build step, framework, runtime npm
dependencies, or analytics. Every interface is one HTML file. The subdomain viewer uses a small same-origin
proxy; share uses a small in-memory service for device discovery and WebRTC
connection setup. File contents travel between browsers, never through the
signaling service.

```
index.html      the index — filter field + registry-driven list
tools.js        the registry. one row per tool.
tokens.css      design tokens (colour, type, space, motion). the only place values live.
s.css           shared stylesheet — every class a tool page may use
s.js            shared runtime — the `E` global, the eyes, theme, header wiring
favicon.svg     one eye
qrcode.min.js   vendored QR encoder; generation remains offline
drand-client.min.js  vendored official drand client; verifies beacon signatures
drand-tools.js   shared PRNG, drand TRNG and Web Crypto randomness helpers
exif-reader.js   vendored ExifReader browser build for image metadata
THIRDPARTYLICENSES  licenses and copyright notices for vendored dependencies
share-server.mjs  ephemeral discovery, private rooms, and WebRTC signaling
subdomains-core.mjs  validation, streaming limits, and crt.name normalization
api/subdomains.js  Node/Vercel adapter for the crt.name proxy
functions/api/subdomains.js  Cloudflare Pages adapter for the same endpoint
_routes.json     limits Cloudflare Pages Functions to /api/*
_redirects       Cloudflare Pages: serves each tool at /<slug> (generated)
vercel.json      Vercel: serves each tool at /<slug> (generated)
scripts/         check.mjs (static checks), static-routes.mjs (writes the two files above)
404.html
t/*.html        one file per tool
_dev/           the contract and the page skeleton — reference material, not shipped code
```

## Running it

Use Node.js 22 or newer (Node 24 recommended). No runtime dependencies to install.

```bash
node dev-server.mjs
```

Then open <http://127.0.0.1:8777>. Each tool lives at a clean address such as
`/share` or `/json`; old `/t/<slug>.html` links redirect there. Pass a different port as the first argument,
for example `node dev-server.mjs 9000`. Most local tools also work when
`index.html` is opened straight off disk. The included server runs
the subdomain viewer's API and the share discovery service. WebRTC sharing needs HTTPS (or localhost
during development) plus a reachable peer.

## Adding a tool

1. Copy `_dev/TEMPLATE.html` to `t/<slug>.html`.
2. Add one row to `tools.js`. The header, title, lede and `<title>` fill
   themselves from it.
3. Run `node scripts/static-routes.mjs` so Vercel and Cloudflare Pages serve the
   page at `/<slug>`. The Node server needs nothing; `npm run check` fails until
   this is done.
4. Follow `_dev/CONTRACT.md`. It is short and it is the whole design system.

## Design

Achromatic. Square corners everywhere. Hairline rules, no shadows, no
gradients, no icons. The only accent is inversion — ink block, paper text —
which is what hover, selection and primary actions all use. One typeface
family (Geist and Geist Mono) in two roles: prose in the sans, anything the
user is going to copy in the mono.

The eyes use the `𓁹𓁹` wordmark. Theme choice persists in the browser; interfaces
support keyboard navigation, visible focus, and reduced motion.

Keyboard: `/` focuses the filter on the index, `↑↓` move, `↵` opens, `Esc`
returns to the index from any tool.

## Deploying

To run the Node server as a service, see [the self-hosting notes](deploy/README.md)
and the [systemd service template](deploy/eyes.service).

Vercel serves the static files and recognizes `api/subdomains.js`:

```bash
npx vercel deploy --prod
```

For Cloudflare Pages, connect the repo with no build command and the project
root as the output directory. The included Pages Function handles
`/api/subdomains`; use Git integration or Wrangler because dashboard Direct
Upload does not deploy Functions.

The Vercel/Pages adapters above handle subdomains only. Share requires the
persistent Node server below, or routing `/api/share/*` to that server. Static
hosts alone cannot provide share discovery or parsed subdomain results.

The `_dev/` folder can be deleted before deploying; nothing links to it.

`qrcode.min.js` is the MIT-licensed qrcode.js 1.0.0 encoder, vendored locally so
the QR tool has no runtime network dependency.

`drand-client.min.js` is the official dual MIT/Apache-2.0 drand client 1.4.2,
bundled locally. TRNG tools contact Cloudflare's drand relay and verify each
beacon against the pinned League of Entropy chain hash and collective public key.

`exif-reader.js` is the ExifReader 4.44.0 browser build, vendored locally under
MPL-2.0. It reads EXIF, IPTC, XMP, ICC, and container metadata from supported
image formats.

All vendored dependency notices are consolidated in [THIRDPARTYLICENSES](THIRDPARTYLICENSES).
The QR encoder includes a local UTF-8 fix for supplementary Unicode characters.
The project's own terms remain in `LICENSE` and `ADDENDUM`.

### Server protections

The Node server publishes an explicit set of website assets. Source modules,
tests, dotfiles, backups, and deployment configuration are not public. HTML gets
a content security policy with hashes for its inline scripts; do not rewrite it
or inject scripts through an edge optimizer. Responses disallow framing and
content-type sniffing. API work has request limits, and subdomain queries share
in-flight requests with a bounded cache. `/healthz` checks process liveness.
SIGTERM/SIGINT close discovery streams and drain HTTP connections for up to ten
seconds before closing the remaining connections.

### Server caching and compression

Published assets are held in memory, keyed by path and invalidated by the file's
mtime and size, so a page is read and its script hashes computed once per edit
rather than once per request. Text assets are compressed to brotli and gzip on
first request and the result is cached alongside the original; the vendored
libraries compress to roughly a quarter of their size. Every asset carries an
ETag and `Last-Modified`, and conditional requests are answered with 304, so a
repeat visit transfers headers only. Compression negotiates on `Accept-Encoding`
and the responses say `Vary: Accept-Encoding`. The content security policy is
still derived from the uncompressed page, so the inline-script hashes are
unaffected.

## Share behind a reverse proxy

Run the persistent Node server (Node 22 or newer) on the same machine as your
reverse proxy. Point the proxy at `http://127.0.0.1:8777`:

```bash
SHARE_TRUST_CLOUDFLARE=1 node dev-server.mjs 8777
```

Set `SHARE_TRUST_CLOUDFLARE=1` in your service manager's environment. This explicitly trusts
Cloudflare's visitor-IP header **only for loopback connections**. With trust enabled,
missing or invalid headers isolate discovery rather than grouping public visitors
under the proxy's address. Keep the origin
bound to loopback and reachable through your proxy only. Do not expose that
trusted origin port directly to untrusted clients. Without the flag, room links
still work; requests carrying Cloudflare headers do not enter a shared localhost
room.

- Open share on both devices on the same network. Press **send files** on a
  device, or drop files onto it. The receiver accepts the whole batch once, then
  downloads each file.
- Across networks, choose **connect another network** and open the generated
  link (or scan its QR code) on the other device. Both devices must use the same
  room link. Anyone with it can join. The server reserves a unique 128-bit room key before returning a link. It lives in the
  URL fragment, outside normal HTTP access logs, and is sent only to the join API.
- Discovery groups devices by network, not physical distance: the public IPv4
  address, or for IPv6 the `/64` prefix that every device on one local network
  shares (each device has its own IPv6 address, so the full address would split
  them up). Two devices on one Wi-Fi where one connects over IPv4 and the other
  over IPv6 cannot be matched, and VPNs or carrier NAT change what a device
  appears to share. Use a room link when automatic discovery does not find the
  intended device. Device names are
  generated labels, not authenticated identities; confirm the intended device
  name before sending or accepting.
- Device IDs, authentication tokens, and the visible four-character device codes
  are checked for uniqueness across all current sessions before they are assigned.
  Collision retries are bounded; allocation fails rather than overwriting a peer.
  Room allocation checks both existing rooms and unused reserved links. Unused
  room reservations expire after 24 idle hours. Opening a shared link intentionally
  joins that room. These checks apply within the single running server process;
  they do not promise codes can never be reused after expiration or a restart.
- The service keeps presence and connection details in memory, with no database
  or file storage. Keep a single Node process for this deployment. Restarting it
  disconnects sessions; browsers automatically rejoin. Horizontal scaling would
  require shared signaling/presence storage.
- A brief loss of the discovery connection — a backgrounded phone, a Wi-Fi blip —
  resumes the same session: the device keeps its name, and connections and
  transfers already running between browsers are not interrupted. The server
  holds a session for about 45 seconds without a connection; after that the
  browser rejoins as a new device. Failed browser-to-browser connections retry
  automatically with backoff; pressing send retries one that has given up.
- Proxy `/api/share/*` to Node, allow streaming `text/event-stream`, disable
  response buffering/caching, and allow long-lived HTTP responses. The service
  sends heartbeats every 15 seconds. No WebSocket upgrade or npm runtime is needed.
- Up to 16 devices per room, 100 files and 256 MB per transfer. Receivers buffer
  accepted files in memory, capped at 512 MB including retained downloads.
  Remove received transfers to release memory. Keep both tabs awake and open.
- Disconnects and interrupted transfers are shown explicitly; partial files
  never become downloads. Send a failed transfer again once the device shows
  ready. Resuming partial files is not supported.

### TURN relay for restrictive networks

STUN is configured by default. Some mobile, corporate, and symmetric-NAT
networks require TURN. An HTTP proxy carries signaling, **not** the
WebRTC data connection. To support those networks, use a TURN service with
REST-style HMAC-SHA1 temporary credentials (such as coturn's shared-secret mode):

```bash
SHARE_TRUST_CLOUDFLARE=1 \
SHARE_TURN_URLS='turn:relay.example:3478,turns:relay.example:5349' \
SHARE_TURN_SECRET='<server-side shared secret>' \
node dev-server.mjs 8777
```

Set real values in the server's service manager or secret store. Do not commit
secrets. The API issues one-hour credentials; the shared secret stays on the
server. Relay traffic remains encrypted by WebRTC. No TURN service or credentials
are provisioned by this repository. Sessions open longer than an hour may need a
page refresh to obtain fresh relay credentials before connecting to new devices.

### Verification

```bash
npm run check
npm test
```

These checks need only Node. For the browser suite, install the locked development
dependency and browser, then start a separate test server:

```bash
npm ci --ignore-scripts
npx playwright install chromium
node dev-server.mjs 8880
```

In another terminal:

```bash
SITE_TEST_URL=http://127.0.0.1:8880 SHARE_TEST_URL=http://127.0.0.1:8880 npm run test:browser
```

`PLAYWRIGHT_MODULE` may point to an existing Playwright module;
`CHROME_PATH` may select an installed Chromium executable. Screenshots go to
`/tmp/eyes-share-tests` (override with `SHARE_TEST_OUTPUT`); the all-page audit writes
its inventory and failures to `/tmp/eyes-site-tests` (`SITE_TEST_OUTPUT`). Keep
unrelated share tabs off the test server so discovery assertions remain isolated.

Checks cover page/script validity, security headers and static access boundaries,
code collisions, upstream failures and limits, JSON number preservation, Unicode,
daylight-saving transitions, binary hashes, image/audio exports, and the tool
interfaces. Real browser-to-browser WebRTC tests cover discovery, room isolation,
binary file integrity, empty files, text, consent, cancellation, and reconnection.
Layouts are checked at five widths in both themes. Browser fixtures replace the
public subdomain and drand responses; they do not test live upstream availability
or the separate server's proxy/TURN setup.
