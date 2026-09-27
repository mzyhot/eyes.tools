# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue or
discussion. Either:

- use **Report a vulnerability** on the repository's Security tab, or
- email mzyhot@tuta.com with the subject line "Security Report".

Include what you found, how to reproduce it, and what an attacker could do with
it. You will get a reply within a week. Please give a fix a reasonable time to
land before disclosing the problem publicly.

## Scope

In scope:

- the share service (`share-server.mjs`): rooms and signaling, including
  anything that lets a visitor see, reach or impersonate a device in a room
  whose link they were not given, or makes file contents pass through the
  server
- the Node server (`dev-server.mjs`): path handling, the published-file allow
  list, security headers and request limits
- any tool that sends data off the device when it says it does not, or
  mishandles untrusted files (images, JSON, text) in a way that runs script
- the static-host configuration exposing files `public-files.mjs` keeps private,
  or dropping the security headers the Node server sends
- the desktop app (`desktop/`): anything that lets a page reach outside the
  window's sandbox, or that makes the app load a page from somewhere other
  than its own embedded copy

Out of scope: denial of service by sheer volume, reports that need a
compromised browser or device, and missing headers with no demonstrated
impact.

Supported: the latest commit on `main`, which is what https://eyes.tools
runs, and the latest release of the desktop app.
