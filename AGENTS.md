# Repository guidance

## Project shape

- The site has no build step or frontend framework. Each tool is a standalone
  HTML file in `t/` and uses the shared files at the repository root.
- `tools.js` is the tool registry. When adding or removing a tool, regenerate
  the static-host files with `node scripts/static-routes.mjs`.
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

- Same-network IPv6 discovery groups addresses by their `/64` prefix, while
  IPv4-mapped IPv6 must agree with the equivalent IPv4 address. Untrusted or
  missing proxy identity must isolate a visitor rather than grouping strangers.
- Preserve same-origin checks, constant-time bearer-token comparison, bounded
  inputs, and the rule that only actively streaming peers may signal each other.

### Published surface

- New source, test, deployment, or dotfiles must remain private unless they are
  deliberately added to the publication allow list in `public-files.mjs`. After
  adding any top-level file, regenerate `.vercelignore` and `_routes.json` with
  `node scripts/static-routes.mjs` so static hosts hide it too.
- Clean tool URLs, legacy redirects, Cloudflare routes, and Vercel rewrites must
  stay consistent. A change that works only on the Node server is incomplete.
