# 𓁹𓁹

**[Explore the codebase wiki →](https://github.com/mzyhot/eyes.tools/wiki)** — setup, tool catalog,
architecture, contributor guides, APIs, deployment, and troubleshooting.

A directory of small, mostly local tools. No build step, framework, runtime npm
dependencies, or analytics. Every interface is one HTML file holding its own
markup and one script; everything around it — the header, the title, the
footer, the fonts, the scripts a tool loads — comes from two registries, so a
change lands in one place. Share gives every visitor a room and a link to pass
on, and a small in-memory service introduces the two devices and relays their
connection setup. File contents travel between browsers, never through it.

```
site.js         the site registry — wordmark, copy, footers, shortcuts, storage keys
tools.js        the tool registry. one row per tool: name, lede, aliases, deps, note.
fonts.css       the two font families. the one file to change to change the type.
tokens.css      design tokens (colour, size, space, motion). the only place values live.
s.css           shared stylesheet — every class a tool page may use
theme.js        applies the saved theme before the first paint
s.js            shared runtime — the `E` global, and the chrome built from the registries
index.js        the index — filter field and registry-driven list
index.html      an empty page index.js fills
redirect.js     drives the compatibility stubs (t/lines.html, t/units.html)
favicon.svg     one eye
404.html        an empty page s.js fills from site.js
t/*.html        one file per tool: its markup and its script, nothing else
qrcode.min.js   vendored QR encoder; generation remains offline
drand-client.min.js  vendored official drand client; verifies beacon signatures
drand-tools.js   shared PRNG, drand TRNG and Web Crypto randomness helpers
exif-reader.js   vendored ExifReader browser build for image metadata
dev-server.mjs   the Node server, for development and self-hosting
api-modules.mjs  the API registry: one row per same-origin endpoint the server mounts
public-files.mjs the root files the site publishes; everything else stays private
share-server.mjs  ephemeral rooms and WebRTC signaling
functions/[[path]].js  Cloudflare Pages: answers private paths with the 404 page
_redirects       Cloudflare Pages: serves each tool at /<slug> (generated)
_routes.json     Cloudflare Pages: sends private paths to a 404 Function (generated)
vercel.json      Vercel: serves each tool at /<slug> (generated)
.vercelignore    Vercel: leaves private files out of the deployment (generated)
scripts/        check.mjs (static checks), static-routes.mjs (writes the four files above)
tests/           Node tests and Playwright browser suites
deploy/          systemd unit, environment example, and self-hosting notes
desktop/         the tools as a Tauri desktop app (Rust); see desktop/README.md
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
`index.html` is opened straight off disk. The included server runs the share
service. WebRTC sharing needs HTTPS (or localhost during development)
plus a reachable peer.

## Desktop app

`desktop/` builds the tools into a desktop app with Tauri. It embeds the same
pages the server publishes and works offline; share uses eyes.tools's service to
find devices, so the app meets people on the website. With Rust installed:

```bash
cd desktop && cargo run
```

[desktop/README.md](desktop/README.md) covers release builds and installers.

## Changing things

| To change | Edit |
| --- | --- |
| The wordmark, footer notes, index copy, the not-found page, keyboard shortcuts, storage keys | `site.js` |
| A tool's name, lede, search aliases, meta description, scripts or footer note | its row in `tools.js` |
| The fonts | `fonts.css`, and drop the files in if you self-host |
| Colours, sizes, spacing, motion | `tokens.css` |
| The header, title block or footer markup itself | `s.js`, once, for every page |
| What a tool does | its file in `t/` |
| Which APIs the server mounts | `api-modules.mjs` |
| What the site publishes | `public-files.mjs` |

## Adding a tool

1. Copy `_dev/TEMPLATE.html` to `t/<slug>.html` and write the tool inside
   `<main>` and the `E.tool(...)` block. Nothing else belongs in the file.
2. Add one row to `tools.js`. The title, header, lede, meta description,
   footer note and any extra scripts (`deps`) all come from it.
3. Run `node scripts/static-routes.mjs` so Vercel and Cloudflare Pages serve the
   page at `/<slug>`. Run it too after adding any file at the top level, so the
   static hosts keep it private. The Node server needs nothing; `npm run check` fails until
   this is done.
4. Follow `_dev/CONTRACT.md`. It is short and it is the whole design system.

Removing a tool is the same two deletions — the row and the file — plus that
script. Nothing else refers to it.

The wiki's [Adding a tool](https://github.com/mzyhot/eyes.tools/wiki/Adding-a-tool)
walks through it in detail.

## Design

Black, white and greys only, with square corners, thin borders, and no
shadows, gradients or icons. Hover, selection and primary buttons invert the
colours rather than adding an accent. Text is set in Geist; anything meant to
be copied uses Geist Mono — both named in `fonts.css`, which is the whole of
the site's typography. There is a light and a dark theme, and the choice is
saved in the browser.

Keyboard: `/` focuses the filter on the index, `↑↓` move, `↵` opens, `Esc`
clears the filter there and returns to the index from any tool.

## Deploying

To get every feature, run the Node server behind a reverse proxy that
terminates HTTPS; [deploy/README.md](deploy/README.md) covers the systemd
service, proxy requirements, and release checks.

Static hosts can serve the tools, but not share:

- **Vercel** reads `vercel.json`: `npx vercel deploy --prod`.
- **Cloudflare Pages** reads `_redirects`, `_routes.json` and `functions/`. Connect
  the repo with no build command and the project root as the output directory,
  through Git integration or Wrangler; dashboard Direct Upload does not deploy
  Functions.

Both hosts publish only what the Node server does: `.vercelignore` and
`_routes.json` hide every file `public-files.mjs` does not list.

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

## Supporting the project

eyes.tools is free, has no ads or analytics, and stays that way. if it saves
you time, you can support its development with the button below!

[![Support us!](.github/assets/support-us-square.svg)](https://square.link/u/JduZKl4L)

## License

AGPL-3.0 ([LICENSE](LICENSE)) with additional terms in [ADDENDUM](ADDENDUM),
including attribution for any copy offered over a network. Read
[License and attribution](https://github.com/mzyhot/eyes.tools/wiki/License-and-attribution)
before publishing a copy.

The vendored `qrcode.min.js` (MIT, with a local UTF-8 fix),
`drand-client.min.js` (MIT/Apache-2.0), and `exif-reader.js` (MPL-2.0) keep
their own licenses, collected in [THIRDPARTYLICENSES](THIRDPARTYLICENSES).
