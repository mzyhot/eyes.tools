/* 𓁹𓁹: what the site publishes.
 *
 * The files a visitor's browser may fetch, by path from the repository root.
 * Tool pages in `t/` are added to this by whoever reads it, because they are
 * discovered rather than listed.
 * Everything else in the repository (server modules, tests, deployment notes,
 * the contract) is private, and stays private when new files are added,
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
  "fonts.css", "tokens.css", "s.css", "site.js", "tools.js", "s.js",
  /* the typeface `fonts.css` names, one file per script */
  "fonts/geist-latin.woff2", "fonts/geist-latin-ext.woff2", "fonts/geist-cyrillic.woff2",
  "fonts/geist-cyrillic-ext.woff2", "fonts/geist-vietnamese.woff2",
  "fonts/geist-mono-latin.woff2", "fonts/geist-mono-latin-ext.woff2", "fonts/geist-mono-cyrillic.woff2",
  "fonts/geist-mono-cyrillic-ext.woff2", "fonts/geist-mono-vietnamese.woff2", "fonts/geist-mono-symbols2.woff2",
  /* page scripts */
  "index.js", "redirect.js",
  /* clean code's formatters, each loaded the first time its language is
     picked; scripts/vendor-formatters.mjs makes them */
  "fmt/clang-format.js", "fmt/clang-format.wasm", "fmt/gofmt.js", "fmt/gofmt.wasm", "fmt/lua.js",
  "fmt/lua.wasm", "fmt/markup.js", "fmt/markup.wasm", "fmt/prettier-angular.js",
  "fmt/prettier-babel.js", "fmt/prettier-estree.js", "fmt/prettier-glimmer.js",
  "fmt/prettier-graphql.js", "fmt/prettier-html.js", "fmt/prettier-ini.js",
  "fmt/prettier-latex.js", "fmt/prettier-markdown.js", "fmt/prettier-nginx.js",
  "fmt/prettier-php.js", "fmt/prettier-postcss.js", "fmt/prettier-properties.js",
  "fmt/prettier-rust.js", "fmt/prettier-svelte.js", "fmt/prettier-typescript.js",
  "fmt/prettier-xml.js", "fmt/prettier-yaml.js", "fmt/prettier.js", "fmt/ruff.js", "fmt/ruff.wasm",
  "fmt/shfmt.js", "fmt/shfmt.wasm", "fmt/sql-formatter.js", "fmt/taplo.js", "fmt/taplo.wasm",
  "fmt/zig.js", "fmt/zig.wasm",
  /* scripts tools name in their `deps` */
  "qrcode.min.js", "drand-tools.js", "drand-client.min.js", "exif-reader.js",
  /* crawler metadata, and the picture link previews show */
  "robots.txt", "sitemap.xml", "preview.png",
  /* notices */
  "THIRDPARTYLICENSES", "fmt/NOTICES.txt", "LICENSE", "ADDENDUM"
];
