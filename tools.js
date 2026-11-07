/* 𓁹𓁹: the tool registry.
 *
 * One entry per tool, and the single source of truth for every place a tool
 * appears. `index.html` renders this list and filters it; `s.js` looks up the
 * entry matching `<body data-tool="…">` and builds that page's title, meta
 * description, breadcrumb, `<h1>` and footer note from it, then loads the
 * scripts the tool needs before running it.
 *
 * Adding a tool is two edits: one file in `t/`, one row here. Removing one is
 * the same two deletions. Nothing else registers a page: there is no build
 * step and no manifest. (`node scripts/static-routes.mjs` regenerates the
 * static-host files afterwards, and `npm run check` fails until it is run.)
 *
 * Fields
 *   slug   Filename stem under `t/`, and the `data-tool` value on the page.
 *          Lowercase, `[a-z0-9-]`; the dev server only publishes names matching
 *          that shape.
 *   name   Display name. Usually the slug; spelled out when the slug is terse
 *          (`exif` → "metadata"). Lowercase, per the contract's voice rules.
 *   meta   The page's `<meta name="description">`, for search results and
 *          previews, and what `find_tool` tells an agent. One sentence; never
 *          shown on the page.
 *   alias  Extra search terms, space separated: synonyms, older names, related
 *          jargon, and the words someone would type who does not know the tool
 *          exists. Never shown; it only widens the filter on the index.
 *   deps   Optional. Scripts the tool needs, in load order, published at the
 *          site root. `s.js` loads them and only then runs the tool's own
 *          script, so a page never lists a `<script src>` itself.
 *   note   Optional. Replaces the footer's "runs in your browser · nothing is
 *          uploaded" for a tool that reaches the network. Say what leaves the
 *          browser and who receives it.
 *   connect  Optional. Sources the Node server adds to this page's
 *          `connect-src`, for a tool that fetches from places it cannot list,
 *          as the downloader fetches media from wherever a video is kept.
 *          Static hosts and the desktop app keep the site's policy, so the
 *          tool must still work, by another route, without it.
 *
 * Order is the order visitors see. It is editorial, roughly most-reached first,
 * and the filter re-ranks on exact and prefix matches rather than re-sorting.
 */
window.TOOLS = [
  { slug: "qr",          name: "qr",                meta: "turn text or a link into a qr code.",
    alias: "qrcode square scan link turn text links qr codes", deps: ["qrcode.min.js", "media.js"] },
  { slug: "barcode",     name: "barcode",           meta: "generate ean-13 barcodes as svg.",
    alias: "upc ean stripes product number make ean-13 barcodes", deps: ["media.js"] },
  { slug: "dump",        name: "dump",              meta: "write, sort, and clean up text in a scratchpad that autosaves in your browser.",
    alias: "paste bin notes write clipboard scratch scratchpad text save lines list sort deduplicate unique duplicates trim reverse cleanup natural order" },
  { slug: "share",       name: "share",             meta: "send files or text over an encrypted WebRTC connection.",
    alias: "file transfer p2p peer webrtc send receive text encrypted files directly", deps: ["qrcode.min.js"],
    note: "device to device · keep both tabs open" },
  { slug: "downloader",  name: "downloader",        meta: "download video or audio from youtube, tiktok, x, bluesky, soundcloud and more, straight to your device where the site allows it.",
    alias: "video download downloader save youtube yt-dlp ytdlp cobalt tiktok twitter x instagram reddit soundcloud bluesky vimeo twitch mp4 mp3 m4a audio music media link grab rip",
    note: "links are looked up on this site's server · files come straight from the source when it allows, else through the server", connect: "https:" },
  { slug: "dir",         name: "dir",               meta: "a filterable directory of real, long-lived websites worth knowing.",
    alias: "links directory bookmarks sites index browse websites" },
  { slug: "base64",      name: "base64",            meta: "encode and decode base64 locally.",
    alias: "b64 atob btoa datauri file encode decode base64 data uris" },
  { slug: "hash",        name: "hash",              meta: "md5, sha-1, sha-256, sha-384, and sha-512 of text or a file, computed in your browser.",
    alias: "sha md5 sha1 sha256 sha512 checksum digest fingerprint hash text files", deps: ["media.js"] },
  { slug: "uuid",        name: "uuid",              meta: "uuid v4, uuid v7, ulid, and short ids, generated in bulk in your browser.",
    alias: "guid ulid nanoid random id generate bulk batch uuids ulids short ids" },
  { slug: "pass",        name: "pass",              meta: "generate passwords and passphrases from local randomness.",
    alias: "password passphrase secret generate random pin passwords passphrases" },
  { slug: "code",        name: "clean code",        meta: "format code in 69 languages, from json, javascript, and python to go, rust, c++, and twenty kinds of sql.",
    alias: "json format formatter languages prettier beautify pretty print tidy indent lint minify validate escape unescape javascript typescript python go rust c cpp csharp java php sql html css yaml toml xml markdown shell" },
  { slug: "url",         name: "url",               meta: "encode, decode, and inspect urls.",
    alias: "uri query param encode decode parse urls" },
  { slug: "case",        name: "case",              meta: "camel, snake, kebab, title, constant, and back.",
    alias: "text transform slug capitals capitalize capitalise upper lower change case" },
  { slug: "color",       name: "color",             meta: "pick a color and get it as hex, rgb, hsl, and oklch.",
    alias: "colour picker pick hex rgb hsl oklch convert swatch css named colors" },
  { slug: "img",         name: "img",               meta: "resize and convert browser-supported image formats.",
    alias: "image photo webp jpeg png gif avif svg bmp resize compress convert format images", deps: ["media.js"] },
  { slug: "diff",        name: "diff",              meta: "compare two texts line by line.",
    alias: "compare changes merge text texts" },
  { slug: "time",        name: "time",              meta: "convert dates and unix timestamps.",
    alias: "epoch unix date timestamp clock utc iso convert timestamps dates" },
  { slug: "count",       name: "count",             meta: "count words, characters, lines, and reading time.",
    alias: "wordcount characters length text stats count estimate reading time" },
  { slug: "lorem",       name: "lorem",             meta: "generate placeholder text by paragraph.",
    alias: "ipsum dummy filler placeholder text generate" },
  { slug: "rng",         name: "rng",               meta: "generate random numbers with prng, trng, or csrng.",
    alias: "random number true secure csrng entropy generate numbers prng trng", deps: ["drand-client.min.js", "drand-tools.js"],
    note: "trng fetches a public drand beacon · prng and csrng stay in your browser" },
  { slug: "dice",        name: "dice",              meta: "roll dice with web crypto, math.random, or a verified drand beacon.",
    alias: "roll random true dice die d6 d20 verified prng trng csrng secure drand", deps: ["drand-client.min.js", "drand-tools.js"],
    note: "trng fetches a public drand beacon · prng and csrng stay in your browser" },
  { slug: "coin",        name: "coin",              meta: "flip coins with web crypto, math.random, or a verified drand beacon.",
    alias: "flip heads tails random true verified coins prng trng csrng secure drand", deps: ["drand-client.min.js", "drand-tools.js"],
    note: "trng fetches a public drand beacon · prng and csrng stay in your browser" },
  { slug: "inspect",     name: "text inspector",    meta: "inspect text as unicode code points or ascii bytes.",
    alias: "unicode ascii utf8 character characters codepoint inspect invisible whitespace" },
  { slug: "char",        name: "character search",  meta: "find unicode and ascii characters by value.",
    alias: "unicode ascii glyph code point u+ search characters html entity" },
  { slug: "exif",        name: "metadata",          meta: "read metadata embedded in image files, or remove it without re-encoding the image.",
    alias: "exif iptc xmp icc image photo camera gps jpeg png webp heic avif view metadata remove strip clean privacy location", deps: ["exif-reader.js", "media.js"] },
  { slug: "spectrogram", name: "spectrogram",       meta: "draw a spectrogram from browser-supported audio files.",
    alias: "audio sound fft frequency waveform make spectrograms", deps: ["media.js"] },
  { slug: "tz",          name: "time zones",        meta: "convert time between zones.",
    alias: "timezone date world clock utc dst convert zones" },
  { slug: "calc",        name: "calculator",        meta: "calculate expressions and convert length, weight, temperature, data, and other units.",
    alias: "calculate expressions math arithmetic percentage percent parentheses power square root units measurements convert length weight mass temperature celsius fahrenheit area volume speed duration data bytes metric imperial" }
];
