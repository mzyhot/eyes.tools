# 𓁹𓁹 desktop

The tools as a desktop app, built with [Tauri](https://tauri.app). The window
shows the pages in this repository, embedded in the binary and served from the
app's own origin, so every tool works offline exactly as it does from the Node
server. No page is loaded from eyes.tools.

Differences from the site:

- **Share uses eyes.tools's service** for its rooms and connection setup — the
  one thing a server is needed for. Files still go device to device, and the
  app's link opens for browsers on the site and other copies of the app. The
  server must list the app's origins in `SHARE_ALLOWED_ORIGINS` (see
  `deploy/README.md`).
- **Links for other people** — dump's text links, share's room links — point at
  eyes.tools, so anyone can open them in a browser.
- **User agent** is `eyes-desktop/<version>`, not a browser's, so a bot check
  that challenges browsers leaves share's requests alone without the site
  having to open its API to everyone.
- **macOS asks for local network access** the first time share runs. Say yes:
  without it macOS blocks the direct connection to a device on the same Wi-Fi,
  and share can only fall back to the long way round or a relay. The reason
  shown in the prompt is in `Info.plist`; the answer is in System Settings →
  Privacy & Security → Local Network.
- **Links to other sites** open in the system browser.
- **Downloads** go to the Downloads folder, renamed `name (2).ext` if the name
  is taken.

## Building

Needs Rust 1.88 or newer. Node is not needed.

```bash
cargo run
```

opens the app from a debug build. For a release build and installers (`.app`
and `.dmg` on macOS, `.msi`/`.exe` on Windows, `.deb`/`.rpm`/`.AppImage` on
Linux):

```bash
cargo install tauri-cli --version "^2" --locked
cargo tauri build
```

The bundles land in `target/release/bundle/`. The released macOS build is
universal, made with `cargo tauri build --target universal-apple-darwin`
(after `rustup target add aarch64-apple-darwin x86_64-apple-darwin`), and lands
in `target/universal-apple-darwin/release/bundle/` instead. The CLI refuses to
start without `dist/`, which the build fills, so on a fresh clone run
`cargo build` (or `mkdir dist`) first. The bundles are unsigned, so macOS asks
before opening one downloaded from elsewhere.

## How it works

```
build.rs         copies the site into dist/ before Tauri embeds it
src/main.rs      the window: routing, outside links, downloads
src/probe.rs     the smoke test (debug builds only)
Info.plist       extra macOS keys, merged into the bundle's own
tauri.conf.json  app name, bundle settings, and the page CSP
icon.svg         the source for icons/ (cargo tauri icon icon.svg)
```

`build.rs` publishes exactly what the Node server does: the root files in
`public-files.mjs` and every page in `t/`, which it writes to the top of
`dist/` as `<slug>.html` so `/json` finds `json.html`. A new tool needs nothing
here; rebuild and it is in the app.

The CSP in `tauri.conf.json` mirrors the one in `dev-server.mjs`, plus
`https://eyes.tools` for share. Keep them in step. Tauri adds hashes for inline
scripts itself; `dangerousDisableAssetCspModification` stops it hashing styles,
which would switch off the `'unsafe-inline'` the pages' `style=""` attributes
need.

The public site is `https://eyes.tools` unless the build sets
`EYES_PUBLIC_ORIGIN`. A build for another server sets that, adds the server to
`connect-src` (by editing `tauri.conf.json`, or with `TAURI_CONFIG` for a
one-off build), and the server lists the app's origins.

## Testing

```bash
EYES_PROBE=1 cargo run
```

opens the index and every page in turn, then saves a download, and fails if a
page does not finish assembling on the right tool, is not a secure context,
or logs a script error, failed load or CSP violation. It prints one line per
step and exits non-zero on any failure.

To test share between the app and a browser, run a server that allows the app,
build the app against it, and open share in a browser on the same machine:

```bash
SHARE_ALLOWED_ORIGINS=tauri://localhost node dev-server.mjs 8880
```

in the repository root, then in `desktop/`:

```bash
EYES_PUBLIC_ORIGIN=http://127.0.0.1:8880 TAURI_CONFIG="{\"app\":{\"security\":{\"csp\":{\"connect-src\":\"'self' http://127.0.0.1:8880\"}}}}" EYES_PROBE=1 EYES_PROBE_PEER=hello EYES_PROBE_ROOM=0123456789abcdef01234567 cargo run
```

and open <http://127.0.0.1:8880/share#room=0123456789abcdef01234567> in a
browser — the same link the app is in — and send the app "hello".
The app sends "from the app" back and passes once both arrive. Keep the screen
awake: WebKit suspends a hidden window's page, connections included.
