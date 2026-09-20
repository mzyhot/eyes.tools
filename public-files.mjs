/* 𓁹𓁹 — what the site publishes.
 *
 * The root files a visitor's browser may fetch. Tool pages in `t/` are added to
 * this by whoever reads it, because they are discovered rather than listed.
 * Everything else in the repository — server modules, tests, deployment notes,
 * the contract — is private, and stays private when new files are added,
 * because nothing publishes a file this list does not name.
 *
 * Two readers keep every host in step:
 *   `dev-server.mjs`              serves exactly these, plus `t/*.html`
 *   `scripts/static-routes.mjs`   writes `.vercelignore` and `_routes.json` so
 *                                 Vercel and Cloudflare Pages hide the rest
 */
export const PUBLIC_ROOT_FILES = [
  /* pages */
  "index.html", "404.html", "favicon.svg",
  /* the shared layer, in load order */
  "fonts.css", "tokens.css", "s.css", "site.js", "theme.js", "tools.js", "s.js",
  /* page scripts */
  "index.js", "redirect.js",
  /* scripts tools name in their `deps` */
  "qrcode.min.js", "drand-tools.js", "drand-client.min.js", "exif-reader.js",
  /* notices */
  "THIRDPARTYLICENSES", "LICENSE", "ADDENDUM"
];
