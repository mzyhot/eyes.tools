# Repository guidance

## Project shape

- The site has no build step or frontend framework. Each tool is a standalone
  HTML file in `t/` holding only its `<main>` and one `E.tool(...)` script; the
  head tags, header, title block and footer are built by `s.js` from `site.js`
  and `tools.js`. A page that writes its own chrome fails `npm run check`.
  `dev-server.mjs` writes the same title and description, with Open Graph
  tags, into the index and each tool page as it serves them, for link
  previews; static hosts serve the files without them.
- `site.js` holds the site's copy and behaviour; `tools.js` is the tool
  registry, including each tool's `deps` (extra scripts) and `note` (footer
  line). `fonts.css` is the only place a font family is named, and the
  typeface's files ship in `fonts/`, each listed in `public-files.mjs`. When
  adding or removing a tool, regenerate the static-host files and `sitemap.xml`
  with `node scripts/static-routes.mjs`.
- `api-modules.mjs` lists the APIs the Node server mounts; the router matches a
  prefix and knows nothing else about them.
- `mcp-server.mjs` answers agents at `/mcp` by running, in the worker threads
  of `mcp-worker.mjs`, the block each tool page marks `core`, so that block
  must use no DOM and no `E`, only the page's `deps` and published files it
  loads through the server's `eyesLoadScript` and `eyesLoadBytes`. Each tool
  in it describes its input (every property, `additionalProperties: false`,
  `examples`) and its answer (`output`), which `agent-schema.js` checks
  against on the page and at `/mcp` alike and the tests check every answer
  against. A tool that takes a file takes it as base64 (`media.js`); only the
  scratchpad's tools stay outside the core, offered on the page alone.
- `fmt/` (clean code's formatters) and `codecs/` (the file tools' image codecs
  and audio decoders) are generated with their notices by
  `node scripts/vendor.mjs` from the versions pinned there; never edit them by
  hand. The WebAssembly ones are why every policy's `script-src` allows
  `'wasm-unsafe-eval'`.
- `dev-server.mjs` is both the local and self-hosted production server.
  `share-server.mjs` provides only discovery and WebRTC signaling; shared file
  contents must never pass through it.
- Preserve the existing visual contract in `_dev/CONTRACT.md` and match the
  surrounding code's style and comment density.

## Verification

Run the checks that cover the changed surface:

```bash
npm run check
npm test
```

For browser or sharing changes, also start `node dev-server.mjs 8880` and run:

```bash
SITE_TEST_URL=http://127.0.0.1:8880 \
SHARE_TEST_URL=http://127.0.0.1:8880 \
npm run test:browser
```

## Code Review Rules

### Share lifecycle

- Distinguish a deliberately removed share session from a temporary discovery
  stream loss. A deliberate leave must remove the remote device immediately;
  a signaling blip must preserve an open WebRTC channel, session identity, and
  any transfer already in flight.
- Keep file and text payloads browser-to-browser. The Node service may relay
  bounded signaling messages but must never receive transferred content.

### Network identity and isolation

- Two sessions meet when they share a room or a known network, and in no other
  way. A room only ever holds the people given its link; a session with no link
  joins the room named by its own id and hands that back.
- A visitor's address decides the join rate limit and the network a session
  joins, counted per IPv6 `/64` and per IPv4 address, with IPv4-mapped IPv6
  agreeing with its plain form. An untrusted or missing proxy header must fall
  back to the socket address rather than be believed, and a network is only
  known from a trusted header or from a request with no proxy header at all,
  never from a loopback, private, link-local or carrier-grade NAT address, which
  would put strangers together. A network holds no more sessions than a room.
- Preserve same-origin checks (cross-origin only for origins an operator lists in
  `SHARE_ALLOWED_ORIGINS`), constant-time bearer-token comparison, bounded
  inputs, and the rule that only actively streaming peers may signal each other.

### Published surface

- New source, test, deployment, or dotfiles must remain private unless they are
  deliberately added to the publication allow list in `public-files.mjs`. After
  adding any top-level file, regenerate `.vercelignore` and `_routes.json` with
  `node scripts/static-routes.mjs` so static hosts hide it too.
- Clean tool URLs, legacy redirects, Cloudflare routes, and Vercel rewrites must
  stay consistent. A change that works only on the Node server is incomplete.
- The static hosts' security headers (`vercel.json`, `_headers`) are generated
  from the table in `dev-server.mjs`; after changing a header there, run
  `node scripts/static-routes.mjs`. They differ only in allowing inline
  scripts, since a static host cannot hash each page's.
- The desktop app (`desktop/`) embeds what `public-files.mjs` and `t/`
  publish, less the web-only files its `build.rs` names, and its CSP in
  `desktop/tauri.conf.json` mirrors `dev-server.mjs`. A CSP change belongs in
  both. For page changes, `EYES_PROBE=1 cargo run` in `desktop/` checks every
  page in the app's WebKit webview.
