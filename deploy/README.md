# Self-hosting notes

These notes cover running the Node server as a long-lived service. The files in
this directory are templates: nothing here changes a server automatically, and
GitHub Actions only runs checks.

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
release; deploy a new revision. A restart resets presence and room reservations;
tabs reconnect, but interrupted transfers must be sent again.

## Reverse proxy

Node listens only on `127.0.0.1:8777`. Put your reverse proxy in front of it and
keep that port off the public internet. The proxy must preserve the public `Host`
header: sharing checks the browser's origin against `Host`, so rewriting it to
`localhost` causes a 403.

`SHARE_TRUST_CLOUDFLARE=1` accepts the `CF-Connecting-IP` visitor-IP header only
from loopback connections. Enable it only when every request reaching Node passes
through a trusted local proxy that sets or preserves the real header. If the header
is absent or invalid, automatic network discovery stays isolated and room links
still work. Never expose a trusted proxy or origin port directly to the internet.

Without the flag, a request carrying `CF-Connecting-IP`, `X-Forwarded-For`,
`X-Real-IP` or `Forwarded` is also isolated, because its socket address is the
proxy's and would put every visitor in one discovery group. Behind any proxy,
automatic discovery therefore needs the flag and a proxy that sets
`CF-Connecting-IP`; room links work either way.

`SHARE_ALLOWED_ORIGINS` lists origins, besides the site's own, whose pages may use
the share service. The desktop app serves its pages itself and uses this
service only to find devices and set up connections, so to serve it set:

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
- Exclude `/api/*` from CDN and proxy caching. A join request should return JSON,
  never an HTML page or a cached response.
- Do not transform HTML/JavaScript or inject scripts at the edge: inline scripts
  use CSP hashes calculated from the original HTML.
- WebRTC sends files directly or through your optional TURN relay. The HTTP proxy
  carries only signaling, not file data. TURN is needed for some NAT/firewall
  combinations; see [Sharing](https://github.com/mzyhot/eyes.tools/wiki/Sharing#stun-and-turn)
  in the wiki for configuration.

## Verify after each release

```bash
sudo systemctl status eyes --no-pager
sudo journalctl -u eyes -n 50 --no-pager
curl --fail http://127.0.0.1:8777/healthz
curl --head http://127.0.0.1:8777/share
```

Then visit your public HTTPS site in two browsers and verify:

1. Same-network devices appear, with different four-character codes.
2. A room link connects devices on different networks.
3. A binary file and a text message arrive intact after the receiver accepts.
4. Cancelling a transfer leaves no partial download; retry works.
5. Discovery still works after leaving both tabs open for at least two minutes.
6. Refreshing and switching rooms do not expose devices from the old room.

Use the browser network panel to diagnose 403s, unexpected HTML responses, or SSE
buffering. `/healthz` confirms the Node process is responding, not that the proxy,
TURN, or cross-network transfer is healthy. Never log session tokens or full
signaling bodies while troubleshooting.

The service is intentionally one process: memory stores presence and code
reservations. Horizontal replicas require
shared coordination first. There is no durable user data to migrate or back up.
