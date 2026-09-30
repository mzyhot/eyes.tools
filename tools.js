/* 𓁹𓁹 — the tool registry.
 *
 * One entry per tool, and the single source of truth for every place a tool
 * appears. `index.html` renders this list and filters it; `s.js` looks up the
 * entry matching `<body data-tool="…">` and builds that page's title, meta
 * description, breadcrumb, `<h1>`, lede and footer note from it, then loads the
 * scripts the tool needs before running it.
 *
 * Adding a tool is two edits: one file in `t/`, one row here. Removing one is
 * the same two deletions. Nothing else registers a page — there is no build
 * step and no manifest. (`node scripts/static-routes.mjs` regenerates the
 * static-host files afterwards, and `npm run check` fails until it is run.)
 *
 * Fields
 *   slug   Filename stem under `t/`, and the `data-tool` value on the page.
 *          Lowercase, `[a-z0-9-]`; the dev server only publishes names matching
 *          that shape.
 *   name   Display name. Usually the slug; spelled out when the slug is terse
 *          (`exif` → "metadata"). Lowercase, per the contract's voice rules.
 *   desc   The lede: one lowercase phrase saying what the visitor walks away
 *          with. Not a feature list. Also the index's second column.
 *   meta   The page's `<meta name="description">`, for search results and
 *          previews. One sentence; may name formats the lede leaves out.
 *   alias  Extra search terms, space separated — synonyms, older names, related
 *          jargon, and the words someone would type who does not know the tool
 *          exists. Never shown; it only widens the filter on the index.
 *   deps   Optional. Scripts the tool needs, in load order, published at the
 *          site root. `s.js` loads them and only then runs the tool's own
 *          script, so a page never lists a `<script src>` itself.
 *   note   Optional. Replaces the footer's "runs in your browser · nothing is
 *          uploaded" for a tool that reaches the network. Say what leaves the
 *          browser and who receives it.
 *
 * Order is the order visitors see. It is editorial, roughly most-reached first,
 * and the filter re-ranks on exact and prefix matches rather than re-sorting.
 */
window.TOOLS = [
  { slug: "qr",          name: "qr",                desc: "make a code someone can scan",                       meta: "turn text or a link into a qr code.",
    alias: "qrcode square scan link turn text links qr codes", deps: ["qrcode.min.js"] },
  { slug: "barcode",     name: "barcode",           desc: "turn a product number into a barcode",               meta: "generate ean-13 barcodes as svg.",
    alias: "upc ean stripes product make ean-13 barcodes" },
  { slug: "dump",        name: "dump",              desc: "write, clean up, and share text",                    meta: "write, sort, and clean up text in a scratchpad that autosaves in your browser.",
    alias: "paste bin notes clipboard scratch scratchpad text save lines list sort deduplicate unique duplicates trim reverse cleanup natural order" },
  { slug: "share",       name: "share",             desc: "send a file straight to someone else's browser",     meta: "send files or text over an encrypted WebRTC connection.",
    alias: "file transfer p2p peer webrtc send receive text encrypted files directly", deps: ["qrcode.min.js"],
    note: "device to device · keep both tabs open" },
  { slug: "dir",         name: "dir",               desc: "useful places to go on the web",                     meta: "a filterable directory of real, long-lived websites worth knowing.",
    alias: "links directory bookmarks sites index browse websites" },
  { slug: "base64",      name: "base64",            desc: "turn text into base64, or bring it back",            meta: "encode and decode base64 locally.",
    alias: "b64 atob btoa datauri file encode decode base64 data uris" },
  { slug: "hash",        name: "hash",              desc: "get a fingerprint for a file or some text",          meta: "md5, sha-1, sha-256, sha-384, and sha-512 of text or a file, computed in your browser.",
    alias: "sha md5 sha1 sha256 sha512 checksum digest fingerprint hash files" },
  { slug: "uuid",        name: "uuid",              desc: "grab a fresh id, or a whole batch",                  meta: "uuid v4, uuid v7, ulid, and short ids, generated in bulk in your browser.",
    alias: "guid ulid nanoid random id generate uuids ulids short ids" },
  { slug: "pass",        name: "pass",              desc: "make a password you don't have to think up",         meta: "generate passwords and passphrases from local randomness.",
    alias: "password passphrase secret generate random pin passwords passphrases" },
  { slug: "json",        name: "json",              desc: "make messy json easier to read",                     meta: "format, minify, validate, and escape json.",
    alias: "pretty print beautify parse lint format minify validate escape unescape" },
  { slug: "url",         name: "url",               desc: "take a link apart and see what's inside",            meta: "encode, decode, and inspect urls.",
    alias: "uri query param encode decode parse urls" },
  { slug: "case",        name: "case",              desc: "fix the capitals without retyping everything",       meta: "camel, snake, kebab, title, constant — and back.",
    alias: "text transform slug capitalize capitalise upper lower change case" },
  { slug: "color",       name: "color",             desc: "see how well two colors work together",              meta: "convert colors and check contrast.",
    alias: "colour hex rgb hsl a11y contrast picker convert check" },
  { slug: "img",         name: "img",               desc: "make an image smaller or change its format",         meta: "resize and convert browser-supported image formats.",
    alias: "image photo webp jpeg png gif avif svg bmp resize compress convert images" },
  { slug: "diff",        name: "diff",              desc: "see what changed between two pieces of text",        meta: "compare two texts line by line.",
    alias: "compare changes merge text texts" },
  { slug: "time",        name: "time",              desc: "turn a timestamp into a date you can read",          meta: "convert dates and unix timestamps.",
    alias: "epoch unix date timestamp clock utc iso convert timestamps dates" },
  { slug: "count",       name: "count",             desc: "see how much you've written",                        meta: "count words, characters, lines, and reading time.",
    alias: "wordcount characters length text stats count estimate reading time" },
  { slug: "lorem",       name: "lorem",             desc: "fill the gaps until your real copy is ready",        meta: "generate placeholder text by paragraph.",
    alias: "ipsum dummy filler placeholder text generate" },
  { slug: "rng",         name: "rng",               desc: "let chance pick a number for you",                   meta: "generate random numbers with prng, trng, or csrng.",
    alias: "random number true secure csrng entropy generate numbers prng trng", deps: ["drand-client.min.js", "drand-tools.js"],
    note: "trng fetches a public drand beacon · prng and csrng stay in your browser" },
  { slug: "dice",        name: "dice",              desc: "roll a die, or a handful at once",                   meta: "roll dice with web crypto, math.random, or a verified drand beacon.",
    alias: "roll random true dice d6 d20 verified prng trng csrng secure drand", deps: ["drand-client.min.js", "drand-tools.js"],
    note: "trng fetches a public drand beacon · prng and csrng stay in your browser" },
  { slug: "coin",        name: "coin",              desc: "settle it with a coin flip",                         meta: "flip coins with web crypto, math.random, or a verified drand beacon.",
    alias: "flip heads tails random true verified coins prng trng csrng secure drand", deps: ["drand-client.min.js", "drand-tools.js"],
    note: "trng fetches a public drand beacon · prng and csrng stay in your browser" },
  { slug: "inspect",     name: "text inspector",    desc: "see the characters and codes behind your text",      meta: "inspect text as unicode code points or ascii bytes.",
    alias: "unicode ascii utf8 character codepoint inspect invisible whitespace" },
  { slug: "char",        name: "character search",  desc: "find the character you're looking for",              meta: "find unicode and ascii characters by value.",
    alias: "unicode ascii glyph code point u+ search characters html entity" },
  { slug: "exif",        name: "metadata",          desc: "see the details tucked inside an image",             meta: "read metadata embedded in image files.",
    alias: "exif iptc xmp icc photo camera gps jpeg png webp heic avif view metadata", deps: ["exif-reader.js"] },
  { slug: "spectrogram", name: "spectrogram",       desc: "see what your audio looks like",                     meta: "draw a spectrogram from browser-supported audio files.",
    alias: "audio sound fft frequency waveform make spectrograms" },
  { slug: "tz",          name: "time zones",        desc: "see what time that is somewhere else",               meta: "convert time between zones.",
    alias: "timezone date world clock utc dst convert zones" },
  { slug: "calc",        name: "calculator",        desc: "calculate expressions and convert units",            meta: "calculate expressions and convert length, weight, temperature, data, and other units.",
    alias: "calculate math arithmetic percentage percent parentheses power square root units measurements convert length weight mass temperature celsius fahrenheit area volume speed duration data bytes metric imperial" }
];
