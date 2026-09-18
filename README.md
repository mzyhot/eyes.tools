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
404.html
t/*.html        one file per tool
qrcode.min.js   vendored QR encoder; generation remains offline
drand-client.min.js  vendored official drand client; verifies beacon signatures
drand-tools.js   shared PRNG, drand TRNG and Web Crypto randomness helpers
exif-reader.js   vendored ExifReader browser build for image metadata
dev-server.mjs   the Node server, for development and self-hosting
share-server.mjs  ephemeral discovery, private rooms, and WebRTC signaling
subdomains-core.mjs  validation, streaming limits, and crt.name normalization
api/subdomains.js  Node/Vercel adapter for the crt.name proxy
functions/api/subdomains.js  Cloudflare Pages adapter for the same endpoint
_routes.json     limits Cloudflare Pages Functions to /api/*
_redirects       Cloudflare Pages: serves each tool at /<slug> (generated)
vercel.json      Vercel: serves each tool at /<slug> (generated)
scripts/         check.mjs (static checks), static-routes.mjs (writes the two files above)
tests/           Node tests and Playwright browser suites
deploy/          systemd unit, environment example, and self-hosting notes
_dev/           the contract and the page skeleton — reference material, not shipped code
THIRDPARTYLICENSES  licenses and copyright notices for vendored dependencies
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

The wiki's [Adding a tool](https://github.com/mzyhot/eyes.tools/wiki/Adding-a-tool)
walks through it in detail.

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

Every feature needs the Node server. Run it behind a reverse proxy that
terminates HTTPS; [deploy/README.md](deploy/README.md) covers the systemd
service, proxy requirements, and release checks.

Static hosts can serve the tools and the subdomain lookup, but not share:

- **Vercel** reads `vercel.json` and `api/subdomains.js`: `npx vercel deploy --prod`.
- **Cloudflare Pages** reads `_redirects` and `functions/`. Connect the repo with
  no build command and the project root as the output directory, through Git
  integration or Wrangler; dashboard Direct Upload does not deploy Functions.

The wiki's [Deployment](https://github.com/mzyhot/eyes.tools/wiki/Deployment) and
[Sharing](https://github.com/mzyhot/eyes.tools/wiki/Sharing) pages cover visitor
addresses behind a proxy, TURN relays, limits, and the security headers the
server sets.

## Testing

```bash
npm run check
npm test
```

These need only Node. The browser suite needs Playwright and a separate server:

```bash
npm ci --ignore-scripts
npx playwright install chromium
node dev-server.mjs 8880
```

In another terminal:

```bash
SITE_TEST_URL=http://127.0.0.1:8880 SHARE_TEST_URL=http://127.0.0.1:8880 npm run test:browser
```

See [Testing and troubleshooting](https://github.com/mzyhot/eyes.tools/wiki/Testing-and-troubleshooting)
for what each suite covers and how to diagnose failures.

## License

AGPL-3.0 ([LICENSE](LICENSE)) with additional terms in [ADDENDUM](ADDENDUM),
including attribution for any copy offered over a network. Read
[License and attribution](https://github.com/mzyhot/eyes.tools/wiki/License-and-attribution)
before publishing a copy.

The vendored `qrcode.min.js` (MIT, with a local UTF-8 fix),
`drand-client.min.js` (MIT/Apache-2.0), and `exif-reader.js` (MPL-2.0) keep
their own licenses, collected in [THIRDPARTYLICENSES](THIRDPARTYLICENSES).
