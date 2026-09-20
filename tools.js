/* 𓁹𓁹 — the tool registry.
 *
 * One entry per tool, and the single source of truth for every place a tool's
 * name appears. `index.html` renders this list and filters it; `s.js` looks up
 * the entry matching `<body data-tool="…">` to fill each tool page's breadcrumb,
 * `<h1>`, lede and `document.title`.
 *
 * Adding a tool is two edits: one file in `t/`, one row here. Nothing else
 * registers a page — there is no build step and no manifest.
 *
 * Fields
 *   slug   Filename stem under `t/`, and the `data-tool` value on the page.
 *          Lowercase, `[a-z0-9-]`; the dev server only publishes names matching
 *          that shape.
 *   name   Display name. Usually the slug; spelled out when the slug is terse
 *          (`exif` → "metadata"). Lowercase, per the contract's voice rules.
 *   desc   The lede: one lowercase phrase saying what the visitor walks away
 *          with. Not a feature list.
 *   alias  Extra search terms, space separated — synonyms, older names, related
 *          jargon, and the words someone would type who does not know the tool
 *          exists. Never shown; it only widens the filter on the index.
 *
 * Order is the order visitors see. It is editorial, roughly most-reached first,
 * and the filter re-ranks on exact and prefix matches rather than re-sorting.
 */
window.TOOLS = [
  { slug: "qr",          name: "qr",                desc: "make a code someone can scan",                       alias: "qrcode square scan link turn text links qr codes" },
  { slug: "barcode",     name: "barcode",           desc: "turn a product number into a barcode",               alias: "upc ean stripes product make ean-13 barcodes" },
  { slug: "dump",        name: "dump",              desc: "write, clean up, and share text",                    alias: "paste bin notes clipboard scratch scratchpad text save lines list sort deduplicate unique duplicates trim reverse cleanup natural order" },
  { slug: "share",       name: "share",             desc: "send a file straight to someone else's browser",     alias: "file transfer p2p peer webrtc send receive text encrypted files directly" },
  { slug: "dir",         name: "dir",               desc: "useful places to go on the web",                     alias: "links directory bookmarks sites index browse websites" },
  { slug: "base64",      name: "base64",            desc: "turn text into base64, or bring it back",            alias: "b64 atob btoa datauri file encode decode base64 data uris" },
  { slug: "hash",        name: "hash",              desc: "get a fingerprint for a file or some text",          alias: "sha md5 sha1 sha256 sha512 checksum digest fingerprint hash files" },
  { slug: "uuid",        name: "uuid",              desc: "grab a fresh id, or a whole batch",                  alias: "guid ulid nanoid random id generate uuids ulids short ids" },
  { slug: "pass",        name: "pass",              desc: "make a password you don't have to think up",         alias: "password passphrase secret generate random pin passwords passphrases" },
  { slug: "json",        name: "json",              desc: "make messy json easier to read",                     alias: "pretty print beautify parse lint format minify validate escape unescape" },
  { slug: "url",         name: "url",               desc: "take a link apart and see what's inside",            alias: "uri query param encode decode parse urls" },
  { slug: "case",        name: "case",              desc: "fix the capitals without retyping everything",       alias: "text transform slug capitalise upper lower change case" },
  { slug: "color",       name: "color",             desc: "see how well two colors work together",              alias: "colour hex rgb hsl a11y contrast picker convert check" },
  { slug: "img",         name: "img",               desc: "make an image smaller or change its format",         alias: "image photo webp jpeg png gif avif svg bmp resize compress convert images" },
  { slug: "diff",        name: "diff",              desc: "see what changed between two pieces of text",        alias: "compare changes merge text texts" },
  { slug: "time",        name: "time",              desc: "turn a timestamp into a date you can read",          alias: "epoch unix date timestamp clock utc iso convert timestamps dates" },
  { slug: "count",       name: "count",             desc: "see how much you've written",                        alias: "wordcount characters length text stats count estimate reading time" },
  { slug: "lorem",       name: "lorem",             desc: "fill the gaps until your real copy is ready",        alias: "ipsum dummy filler placeholder text generate" },
  { slug: "rng",         name: "rng",               desc: "let chance pick a number for you",                   alias: "random number true secure csrng entropy generate numbers prng trng" },
  { slug: "dice",        name: "dice",              desc: "roll a die, or a handful at once",                   alias: "roll random true dice d6 d20 verified" },
  { slug: "coin",        name: "coin",              desc: "settle it with a coin flip",                         alias: "flip heads tails random true verified coins" },
  { slug: "inspect",     name: "text inspector",    desc: "see the characters and codes behind your text",      alias: "unicode ascii utf8 character codepoint inspect invisible whitespace" },
  { slug: "char",        name: "character search",  desc: "find the character you're looking for",              alias: "unicode ascii glyph code point u+ search characters html entity" },
  { slug: "exif",        name: "metadata",          desc: "see the details tucked inside an image",             alias: "exif iptc xmp icc photo camera gps jpeg png webp heic avif view metadata" },
  { slug: "spectrogram", name: "spectrogram",       desc: "see what your audio looks like",                     alias: "audio sound fft frequency waveform make spectrograms" },
  { slug: "tz",          name: "time zones",        desc: "see what time that is somewhere else",               alias: "timezone date world clock utc dst convert zones" },
  { slug: "calc",        name: "calculator",        desc: "calculate expressions and convert units",            alias: "calculate math arithmetic percentage percent parentheses power square root units measurements convert length weight mass temperature celsius fahrenheit area volume speed duration data bytes metric imperial" }
];
