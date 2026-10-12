# Self-hosting notes

These notes cover running the Node server as a long-lived service. The files in
this directory are templates: nothing here changes a server automatically, and
GitHub Actions never deploys the site. It runs the checks and builds the desktop
app's installers.

## Runtime and service

Use Node.js 24, or another supported release at least version 22. The server has
no npm runtime dependencies or build step. Playwright is a development dependency.

Install Node from your operating system's packages and check the executable and
version before using the service template:

```bash
node --version
command -v node
sudo useradd --system --home-dir /opt/eyes --shell /usr/sbin/nologin eyes
sudo install -d -m 0755 /opt/eyes/releases
sudo install -d -m 0700 /etc/eyes
```

Skip user creation if the dedicated `eyes` account already exists. The template
uses `/usr/bin/node` and the paths above; adjust them for your host. Keep the
deployment checkout under your deployment account, outside the serving directory.
Do not put deployment credentials in the service account's environment.

From a clean checkout of the revision you want to deploy:

```bash
set -euo pipefail
git diff --exit-code
git diff --cached --exit-code
node scripts/check.mjs
node --test tests/*.test.mjs
release_id=$(git rev-parse HEAD)
release_dir="/opt/eyes/releases/$release_id"
sudo install -d -m 0755 "$release_dir"
git archive --format=tar HEAD | sudo tar -xf - -C "$release_dir"
sudo chmod -R a+rX "$release_dir"
sudo ln -sfn "$release_dir" /opt/eyes/current
```

Deploy a revision whose GitHub checks passed. Release files should be owned by
the deploying administrator, not writable by `eyes`. On initial installation:

```bash
sudo install -m 0600 deploy/eyes.env.example /etc/eyes/eyes.env
sudo install -m 0644 deploy/eyes.service /etc/systemd/system/eyes.service
sudo systemctl daemon-reload
sudo systemctl enable --now eyes
curl --fail http://127.0.0.1:8777/healthz
```

On later updates, preserve `/etc/eyes/eyes.env`, switch the release symlink and
run `sudo systemctl restart eyes`. Keep the previous release directory and record
its path before switching. To roll back, point `/opt/eyes/current` at that previous
directory, restart `eyes`, and check `/healthz` again. Never edit files in an active
release; deploy a new revision. A restart forgets every session; tabs rejoin their
rooms by link, but interrupted transfers must be sent again.

## Reverse proxy

Node listens only on `127.0.0.1:8777`. Put your reverse proxy in front of it and
keep that port off the public internet. The proxy must preserve the public `Host`
header: sharing checks the browser's origin against `Host`, so rewriting it to
`localhost` causes a 403.

`SHARE_TRUST_CLOUDFLARE=1` accepts the `CF-Connecting-IP` visitor-IP header only
from loopback connections. It decides the join rate limit, which counts per
visitor network, and which network a visitor's devices find each other on.
Enable it only when every request reaching Node passes through a trusted local
proxy that sets or preserves the real header. Without it, behind a proxy, every
visitor's joins count against one limit (the proxy's own address), so a busy
site needs the flag, and devices meet by link only, because the proxy's address
is never used as a network. Never expose a trusted proxy or origin port directly
to the internet.

`SHARE_ALLOWED_ORIGINS` lists origins, besides the site's own, whose pages may use
the share service. The desktop app serves its pages itself and uses this
service only for rooms and connection setup, so to serve it set:

```
SHARE_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost
```

(`tauri://localhost` is the app on macOS and Linux, `http://tauri.localhost` on
Windows.) Only listed origins get CORS headers; unset, the service is same-origin
only. The app identifies itself as `eyes-desktop/<version>` rather than as a
browser, so a bot check that challenges browser-like clients, as Anubis does by
default, lets it through with no rule opening `/api/share/*`.

### Required proxy behavior

- `/api/share/*` stays on the website's origin. Preserve Authorization, cookies,
  request bodies, and the public Host.
- `/api/share/events` is an unbuffered `text/event-stream` response with caching
  disabled. Heartbeats arrive every 15 seconds; the browser reconnects after
  45 seconds without data. Avoid a proxy read timeout below that interval.
- Exclude `/api/*` and `/mcp` from CDN and proxy caching. A join request should return JSON,
  never an HTML page or a cached response.
- Do not transform HTML/JavaScript or inject inline scripts at the edge: inline
  scripts use CSP hashes calculated from the original HTML. An added
  same-origin script tag leaves those hashes intact, so Cloudflare's WebMCP
  bridge (`/.webmcp/bridge.js`, injected when WebMCP is on under Agent
  Readiness) runs under the policy as it is, beside the tools each page
  registers itself. Its Site MCP server pack reads tools from `/mcp`, the
  site's own MCP server, and offers them to agents in the browser too.
- `/mcp` stays on the website's origin: `POST` JSON in, JSON out, never
  cached. Agents call it from their own servers, with no browser or cookies and
  often with an AI user agent, so a bot check must let `POST /mcp` through;
  with Anubis, allow the path `^/mcp$` ahead of any rule denying AI user agents.
  Browser pages on other sites are refused unless listed in
  `MCP_ALLOWED_ORIGINS`, which works as `SHARE_ALLOWED_ORIGINS` does.
- WebRTC sends files directly or through your optional TURN relay. The HTTP proxy
  carries only signaling, not file data. TURN is needed for some NAT/firewall
  combinations; see [Sharing](https://github.com/mzyhot/eyes.tools/wiki/Sharing#stun-and-turn)
  in the wiki for configuration.

### GitHub deployment webhook

The Node service exposes one deployment hook at `POST /api/github/sync`. It
accepts only JSON POST requests whose `X-Hub-Signature-256` matches the HMAC
SHA-256 signature GitHub computes with `GITHUB_SECRET`, and only for
`mzyhot/eyes.tools`. A valid request queues the protected
`eyes-updater.service`, which checks out the verified `main` release. The
webhook body is never used as a command or as a Git ref.

The updater unit is not in this repository: it is the host's own, holds the
GitHub credentials the web service never sees, and runs the release steps
above. Without it a valid request is answered 503 and nothing changes. With
`GITHUB_SECRET` unset the hook is off and answers every request with 503.

Set the same random value in the service environment on the host:

```
GITHUB_SECRET=replace-with-a-long-random-value
```

In the GitHub repository settings, create a webhook pointing to
`https://eyes.tools/api/github/sync`, choose `application/json`, and use that
same secret. Subscribe to the events you want to trigger a check (a `push`
to `main` is sufficient). Keep the endpoint out of CDN caches and preserve
its POST body and `X-Hub-Signature-256` header.

## Verify after each release

```bash
sudo systemctl status eyes --no-pager
sudo journalctl -u eyes -n 50 --no-pager
curl --fail http://127.0.0.1:8777/healthz
curl --head http://127.0.0.1:8777/share
curl --fail -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8777/mcp
curl --fail -s http://127.0.0.1:8777/qr | grep 'og:image'
```

Link previews and the sitemap name the address in `url` in `site.js`. A copy
served from anywhere but https://eyes.tools sets it to its own address and
runs `node scripts/static-routes.mjs`, or previews of its pages link to
eyes.tools.

Then visit your public HTTPS site in two browsers and verify:

1. Share opens with a link and a code, and the two devices show different
   four-character codes once the link is opened on the second one.
2. The link connects devices on different networks, and two devices on one
   Wi-Fi find each other without it (needs `SHARE_TRUST_CLOUDFLARE=1` behind
   Cloudflare; Private Relay, a VPN or IPv6 on one device can still split them).
3. A binary file and a text message arrive intact after the receiver accepts.
4. Cancelling a transfer leaves no partial download; retry works.
5. The room still works after leaving both tabs open for at least two minutes.
6. Taking a new link, and closing one device for half a minute, both leave the
   old link connecting nobody.

Use the browser network panel to diagnose 403s, unexpected HTML responses, or SSE
buffering. `/healthz` confirms the Node process is responding, not that the proxy,
TURN, or cross-network transfer is healthy. Never log session tokens or full
signaling bodies while troubleshooting.

The service is intentionally one process: memory holds its sessions, rooms and
code reservations. Horizontal replicas require shared coordination first. There
is no durable user data to migrate or back up.
