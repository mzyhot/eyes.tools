/* 𓁹𓁹: the third-party code tools load, vendored into `fmt/` and `codecs/`.
 *
 * The site has no build step, so what a tool needs from npm ships as a file a
 * page loads with a plain <script>, and a WebAssembly module's `.wasm` beside
 * it. This makes them all from the pinned npm packages below:
 *
 *   node scripts/vendor.mjs
 *
 * It installs the packages into a temporary folder, writes both folders, and
 * prints what it wrote. Nothing it installs reaches the repository but them.
 * After changing a version, run `npm run check`, `npm test` and the browser
 * suite, and try the tools that load what changed.
 *
 * fmt/, clean code's formatters. What each file defines when it has run:
 *   prettier.js            `prettier`, Prettier's standalone build
 *   prettier-<name>.js     `prettierPlugins.<name>`, a Prettier plugin
 *   sql-formatter.js       `sqlFormatter`
 *   <name>.js + .wasm      `wasmFmt.<name>`: `init(bytes)` once, then `format()`
 *
 * codecs/, the image codecs and audio decoders the file tools use wherever a
 * browser's own are not there to ask, as on the MCP server, and the muxer the
 * downloader joins streams with. Each defines `eyesCodecs.<name>`:
 * `init(bytes)` once, with the bytes of its `.wasm` (an audio decoder, the
 * muxer and the mp3 encoder carry their own and take none), then the one
 * thing it does:
 *   png                    decode(bytes) → { data, width, height }, encode(rgba, w, h)
 *   jpeg-decode            decode(bytes), turned as the photo's orientation says
 *   jpeg-encode            encode(rgba, w, h, quality)
 *   webp-decode            decode(bytes)
 *   webp-encode            encode(rgba, w, h, quality)
 *   resize                 resize(rgba, w, h, toW, toH) → rgba, lanczos3 in linear light
 *   mp3, flac, vorbis, opus  decode(bytes, limit) → Promise of { channels, sampleRate },
 *                          refusing a sound past limit samples, all channels counted
 *   mux                    join(parts, { video, audio, mp3, onProgress }) → Promise of { blob, ext }:
 *                          the first video and sound tracks among them in one file, copied, in
 *                          the container their codecs suit; a part is a Blob or an HLS playlist's address
 *   mp3-encode             lets mux make mp3; loaded after it, since it adds to it
 *
 * Each folder's NOTICES.txt says what every other file there contains and
 * carries the license texts: each npm package in it, each project a
 * WebAssembly build compiles (fetched from GitHub), and each Rust crate the
 * build names (from crates.io).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VERSIONS = {
  'prettier': '3.9.10',
  '@prettier/plugin-php': '0.25.0',
  '@prettier/plugin-xml': '3.4.2',
  'prettier-plugin-svelte': '4.1.1',
  'svelte': '5.57.2',
  'prettier-plugin-nginx': '2.0.0',
  'prettier-plugin-ini': '1.3.0',
  'prettier-plugin-properties': '0.3.1',
  'prettier-plugin-rust': '0.1.9',
  'prettier-plugin-latex': '2.0.1',
  'sql-formatter': '15.9.0',
  '@wasm-fmt/clang-format': '23.1.1',
  '@wasm-fmt/ruff_fmt': '0.15.20',
  '@wasm-fmt/gofmt': '0.7.3',
  '@wasm-fmt/lua_fmt': '0.3.3',
  '@wasm-fmt/zig_fmt': '0.16.0',
  '@wasm-fmt/shfmt': '0.2.7',
  '@wasm-fmt/taplo_fmt': '0.2.5',
  '@wasm-fmt/markup_fmt': '0.2.9',
  '@jsquash/png': '3.1.1',
  '@jsquash/jpeg': '1.6.0',
  '@jsquash/webp': '1.5.0',
  '@jsquash/resize': '2.1.1',
  'mpg123-decoder': '1.0.3',
  '@wasm-audio-decoders/flac': '0.2.11',
  '@wasm-audio-decoders/ogg-vorbis': '0.1.20',
  'ogg-opus-decoder': '1.7.5',
  'mediabunny': '1.61.3',
  '@mediabunny/mp3-encoder': '1.61.3',
  'esbuild': '0.28.2'
};

/* Prettier's own builds already define their globals. */
const PRETTIER_UMD = ['babel', 'estree', 'typescript', 'postcss', 'html', 'angular', 'glimmer', 'markdown', 'yaml', 'graphql'];

/* Plugins published as modules: bundled, with their imports of Prettier
   pointed at the `prettier` global the page has already loaded. */
const PRETTIER_BUNDLED = {
  xml: '@prettier/plugin-xml',
  svelte: 'prettier-plugin-svelte/browser',
  nginx: 'prettier-plugin-nginx',
  ini: 'prettier-plugin-ini',
  properties: 'prettier-plugin-properties',
  rust: 'prettier-plugin-rust',
  latex: 'prettier-plugin-latex'
};

/* WebAssembly formatters: the package's browser entry, and its .wasm. */
const WASM = {
  'clang-format': ['@wasm-fmt/clang-format/clang-format-web.js', '@wasm-fmt/clang-format/clang-format.wasm'],
  ruff: ['@wasm-fmt/ruff_fmt/ruff_fmt_web.js', '@wasm-fmt/ruff_fmt/ruff_fmt_bg.wasm'],
  gofmt: ['@wasm-fmt/gofmt/gofmt_web.js', '@wasm-fmt/gofmt/gofmt.wasm'],
  lua: ['@wasm-fmt/lua_fmt/lua_fmt_web.js', '@wasm-fmt/lua_fmt/lua_fmt_bg.wasm'],
  zig: ['@wasm-fmt/zig_fmt/zig_fmt_web.js', '@wasm-fmt/zig_fmt/zig_fmt.wasm'],
  shfmt: ['@wasm-fmt/shfmt/shfmt_web.js', '@wasm-fmt/shfmt/shfmt.wasm'],
  taplo: ['@wasm-fmt/taplo_fmt/taplo_fmt_web.js', '@wasm-fmt/taplo_fmt/taplo_fmt_bg.wasm'],
  markup: ['@wasm-fmt/markup_fmt/markup_fmt_web.js', '@wasm-fmt/markup_fmt/markup_fmt_bg.wasm']
};

/* What each WebAssembly build compiles besides its npm wrapper: the project,
   and the toolchain whose runtime it carries, with each one's license file,
   from GitHub or, written `npm:`, from the installed package. A fifth entry is
   a note the notices print with it. */
const LLVM = ['LLVM', 'Apache-2.0 WITH LLVM-exception', 'https://github.com/llvm/llvm-project', 'llvm/llvm-project/main/clang/LICENSE.TXT'];
const EMSCRIPTEN = ['Emscripten', 'MIT OR NCSA', 'https://github.com/emscripten-core/emscripten', 'emscripten-core/emscripten/main/LICENSE'];
const GO = ['Go', 'BSD-3-Clause', 'https://github.com/golang/go', 'golang/go/master/LICENSE'];
const TINYGO = ['TinyGo', 'BSD-3-Clause', 'https://github.com/tinygo-org/tinygo', 'tinygo-org/tinygo/release/LICENSE'];
const UPSTREAM = {
  'clang-format': [LLVM, EMSCRIPTEN],
  ruff: [['Ruff', 'MIT', 'https://github.com/astral-sh/ruff', 'astral-sh/ruff/main/LICENSE']],
  gofmt: [GO, TINYGO],
  lua: [['StyLua', 'MPL-2.0', 'https://github.com/JohnnyMorganz/StyLua', 'JohnnyMorganz/StyLua/main/LICENSE.md']],
  zig: [['Zig', 'MIT', 'https://github.com/ziglang/zig', 'ziglang/zig/master/LICENSE']],
  shfmt: [['sh', 'BSD-3-Clause', 'https://github.com/mvdan/sh', 'mvdan/sh/master/LICENSE'], GO, TINYGO],
  taplo: [['Taplo', 'MIT', 'https://github.com/tamasfe/taplo', 'tamasfe/taplo/master/LICENSE']],
  markup: [['markup_fmt', 'MIT', 'https://github.com/g-plane/markup_fmt', 'g-plane/markup_fmt/main/LICENSE']]
};

/* The codecs. Each entry's source gives `eyesCodecs.<name>` the shape the head
   of this file lists, so the tools need not know whose build it is. An
   Emscripten build is handed its WebAssembly through `instantiateWasm`, a
   wasm-bindgen one through its init; neither then looks for a file. */
const IMAGE_DATA = `if (typeof globalThis.ImageData !== "function") globalThis.ImageData = function ImageData(data, width, height) { this.data = data; this.width = width; this.height = height; };
const codecs = globalThis.eyesCodecs = globalThis.eyesCodecs || {};
const plain = image => ({ data: image.data, width: image.width, height: image.height });
const bytesOf = view => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);`;
const EMSCRIPTEN_INIT = `const start = (factory, bytes) => new Promise((resolve, reject) => {
  factory({ noInitialRun: true, instantiateWasm(imports, done) { WebAssembly.instantiate(bytes, imports).then(result => done(result.instance), reject); return {}; } }).then(resolve, reject);
});`;
const AUDIO = (name, pkg, decoder) => `import { ${decoder} } from ${JSON.stringify(pkg)};
(globalThis.eyesCodecs = globalThis.eyesCodecs || {})[${JSON.stringify(name)}] = {
  init: () => Promise.resolve(),
  /* A decoder holds its stream's state, so each file gets its own. It is fed
     the file in slices, so a sound past \`limit\` samples, across its
     channels, is refused before it is all held. */
  decode: async (bytes, limit = Infinity) => {
    const decoder = new ${decoder}(), parts = [];
    let samples = 0, sampleRate = 0, count = 0;
    const take = out => {
      if (!out || !out.samplesDecoded) return;
      parts.push(out.channelData);
      samples += out.samplesDecoded;
      sampleRate = out.sampleRate;
      count = Math.max(count, out.channelData.length);
      if (samples * count > limit) throw new RangeError("longer than the limit");
    };
    try {
      await decoder.ready;
      for (let at = 0; at < bytes.length; at += 65536) take(await decoder.decode(bytes.subarray(at, at + 65536)));
      if (decoder.flush) take(await decoder.flush());
    } finally { decoder.free(); }
    const channels = [];
    for (let c = 0; c < count; c++) {
      const channel = new Float32Array(samples);
      let at = 0;
      for (const part of parts) {
        if (part[c]) channel.set(part[c], at);
        at += part[0].length;
      }
      channels.push(channel);
    }
    return { channels, sampleRate };
  }
};`;
/* The muxer: Mediabunny's conversions, each told to keep one kind of track,
   adding to one output, so a video stream and a sound stream become one file
   with their packets copied as they are. A part is a Blob, or the address of
   an HLS playlist, which Mediabunny fetches segment by segment itself. The
   container follows the codecs the tracks really hold, as yt-dlp's own
   mp4/webm/mkv would: webm for the open codecs, mp4 where it plays almost
   everywhere, Matroska for the rest; sound alone keeps its own kind of file.
   An mp4's index goes at its end, as ffmpeg writes it by default, and the
   output goes straight into Blob pieces, a later write over an earlier one
   splicing it, so the page never holds the finished file itself and the
   browser may keep it on disk; the inputs are let go once joined.
   Only sound bound for an mp3 is re-encoded, which needs mp3-encode. What
   mp3-encode needs from Mediabunny it takes from here, so the encoder joins
   this copy's registry. */
const MUX = `import { ALL_FORMATS, BlobSource, Conversion, CustomAudioEncoder, EncodedPacket, HLS_FORMATS, Input, Logging, MkvOutputFormat,
  Mp3OutputFormat, Mp4OutputFormat, OggOutputFormat, Output, StreamTarget, UrlSource, WebMOutputFormat, registerEncoder } from "mediabunny";
/* A file built of Blob pieces by position. */
function pieces() {
  let list = [];
  return {
    write({ data, position }) {
      const end = position + data.byteLength, kept = [];
      for (const piece of list) {
        const pieceEnd = piece.at + piece.blob.size;
        if (pieceEnd <= position || piece.at >= end) { kept.push(piece); continue; }
        if (piece.at < position) kept.push({ at: piece.at, blob: piece.blob.slice(0, position - piece.at) });
        if (pieceEnd > end) kept.push({ at: end, blob: piece.blob.slice(end - piece.at) });
      }
      kept.push({ at: position, blob: new Blob([data]) });
      list = kept.sort((a, b) => a.at - b.at);
    },
    blob: type => new Blob(list.map(piece => piece.blob), { type })
  };
}
const OPEN_VIDEO = ["vp8", "vp9", "av1"], MP4_VIDEO = ["avc", "hevc", "vp9", "av1"], MP4_AUDIO = ["aac", "mp3", "opus", "flac", "ac3", "eac3"];
function container(video, audio, mp3) {
  if (mp3) return [new Mp3OutputFormat(), "mp3"];
  if (video) {
    if (OPEN_VIDEO.includes(video) && (!audio || audio === "opus" || audio === "vorbis")) return [new WebMOutputFormat(), "webm"];
    if (MP4_VIDEO.includes(video) && (!audio || MP4_AUDIO.includes(audio))) return [new Mp4OutputFormat({ fastStart: false }), "mp4"];
    return [new MkvOutputFormat(), "mkv"];
  }
  if (audio === "aac") return [new Mp4OutputFormat({ fastStart: false }), "m4a"];
  if (audio === "mp3") return [new Mp3OutputFormat(), "mp3"];
  if (audio === "opus" || audio === "vorbis") return [new OggOutputFormat(), audio === "opus" ? "opus" : "ogg"];
  return [new MkvOutputFormat(), "mka"];
}
(globalThis.eyesCodecs = globalThis.eyesCodecs || {}).mux = {
  init: () => Promise.resolve(),
  mediabunny: { CustomAudioEncoder, EncodedPacket, Logging, registerEncoder },
  join: async (parts, { video = true, audio = true, mp3 = false, onProgress }) => {
    const takes = [];
    for (const part of parts) {
      const input = typeof part === "string"
        ? new Input({ source: new UrlSource(part, { requestInit: { credentials: "omit", referrerPolicy: "no-referrer" } }), formats: HLS_FORMATS })
        : new Input({ source: new BlobSource(part), formats: ALL_FORMATS });
      const videoTrack = video && !mp3 ? await input.getPrimaryVideoTrack() : null;
      const audioTrack = audio ? await input.getPrimaryAudioTrack() : null;
      if (!videoTrack && !audioTrack) continue;
      if (videoTrack) video = false;
      if (audioTrack) audio = false;
      takes.push({ input, videoTrack, audioTrack });
    }
    if (!takes.length) throw new Error("these streams hold nothing to keep");
    const codec = async kind => { const take = takes.find(t => t[kind]); return take ? take[kind].getCodec() : null; };
    const [format, ext] = container(await codec("videoTrack"), await codec("audioTrack"), mp3);
    const file = pieces();
    const output = new Output({ format, target: new StreamTarget(new WritableStream({ write: chunk => file.write(chunk) }), { chunked: true }) });
    const conversions = [];
    for (const { input, videoTrack, audioTrack } of takes) {
      const conversion = await Conversion.init({
        input, output, composable: true,
        video: videoTrack ? {} : { discard: true },
        audio: audioTrack ? (mp3 ? { codec: "mp3", bitrate: 256000 } : {}) : { discard: true }
      });
      if (!conversion.isValid) throw new Error("this browser cannot read these streams");
      conversions.push(conversion);
    }
    const done = conversions.map(() => 0);
    conversions.forEach((conversion, at) => {
      conversion.onProgress = value => { done[at] = value; if (onProgress) onProgress(done.reduce((a, b) => a + b, 0) / done.length); };
    });
    await output.start();
    await Promise.all(conversions.map(conversion => conversion.execute()));
    await output.finalize();
    for (const take of takes) take.input.dispose();
    return { blob: file.blob(format.mimeType), ext };
  }
};`;
/* mp3-encode's imports of Mediabunny, answered by the muxer's. */
const muxGlobal = {
  name: 'mux-global',
  setup(build) {
    build.onResolve({ filter: /^mediabunny$/ }, args => ({ path: args.path, namespace: 'mux-global' }));
    build.onLoad({ filter: /.*/, namespace: 'mux-global' }, () => ({ contents: 'module.exports = globalThis.eyesCodecs.mux.mediabunny;', loader: 'js' }));
  }
};
const XIPH = (name, repo, file) => [name, 'BSD-3-Clause', 'https://github.com/xiph/' + repo, 'xiph/' + repo + '/' + file];
const CODECS = {
  png: {
    wasm: '@jsquash/png/codec/pkg/squoosh_png_bg.wasm',
    upstream: [['Squoosh png', 'Apache-2.0', 'https://github.com/GoogleChromeLabs/squoosh', 'npm:@jsquash/png/codec/LICENSE.codec.md']],
    source: `import init, { decode, encode } from "@jsquash/png/codec/pkg/squoosh_png.js";
${IMAGE_DATA}
codecs.png = { init: bytes => init(bytes), decode: bytes => plain(decode(bytes)), encode: (rgba, width, height) => encode(bytesOf(rgba), width, height, 8) };`
  },
  'jpeg-decode': {
    wasm: '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm',
    upstream: [['MozJPEG', 'IJG AND BSD-3-Clause AND Zlib', 'https://github.com/mozilla/mozjpeg', 'npm:@jsquash/jpeg/codec/LICENSE.codec.md'], EMSCRIPTEN],
    source: `import factory from "@jsquash/jpeg/codec/dec/mozjpeg_dec.js";
${IMAGE_DATA}
${EMSCRIPTEN_INIT}
let codec;
codecs["jpeg-decode"] = {
  init: bytes => start(factory, bytes).then(module => { codec = module; }),
  /* true: turned upright as the photo's orientation tag says, as a browser shows it. */
  decode: bytes => { const image = codec.decode(bytes, true); if (!image) throw new Error("that jpeg could not be read"); return plain(image); }
};`
  },
  'jpeg-encode': {
    wasm: '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm',
    upstream: [['MozJPEG', 'IJG AND BSD-3-Clause AND Zlib', 'https://github.com/mozilla/mozjpeg', 'npm:@jsquash/jpeg/codec/LICENSE.codec.md'], EMSCRIPTEN],
    source: `import factory from "@jsquash/jpeg/codec/enc/mozjpeg_enc.js";
import { defaultOptions } from "@jsquash/jpeg/meta.js";
${IMAGE_DATA}
${EMSCRIPTEN_INIT}
let codec;
codecs["jpeg-encode"] = {
  init: bytes => start(factory, bytes).then(module => { codec = module; }),
  encode: (rgba, width, height, quality) => codec.encode(rgba, width, height, Object.assign({}, defaultOptions, { quality: quality, chroma_quality: quality }))
};`
  },
  'webp-decode': {
    wasm: '@jsquash/webp/codec/dec/webp_dec.wasm',
    upstream: [['libwebp', 'BSD-3-Clause', 'https://github.com/webmproject/libwebp', 'npm:@jsquash/webp/codec/LICENSE.codec.md'], EMSCRIPTEN],
    source: `import factory from "@jsquash/webp/codec/dec/webp_dec.js";
${IMAGE_DATA}
${EMSCRIPTEN_INIT}
let codec;
codecs["webp-decode"] = {
  init: bytes => start(factory, bytes).then(module => { codec = module; }),
  decode: bytes => { const image = codec.decode(bytes); if (!image) throw new Error("that webp could not be read"); return plain(image); }
};`
  },
  'webp-encode': {
    wasm: '@jsquash/webp/codec/enc/webp_enc.wasm',
    upstream: [['libwebp', 'BSD-3-Clause', 'https://github.com/webmproject/libwebp', 'npm:@jsquash/webp/codec/LICENSE.codec.md'], EMSCRIPTEN],
    source: `import factory from "@jsquash/webp/codec/enc/webp_enc.js";
import { defaultOptions } from "@jsquash/webp/meta.js";
${IMAGE_DATA}
${EMSCRIPTEN_INIT}
let codec;
codecs["webp-encode"] = {
  init: bytes => start(factory, bytes).then(module => { codec = module; }),
  encode: (rgba, width, height, quality) => { const out = codec.encode(rgba, width, height, Object.assign({}, defaultOptions, { quality: quality })); if (!out) throw new Error("webp encoding failed"); return out; }
};`
  },
  resize: {
    wasm: '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm',
    upstream: [['Squoosh resize', 'Apache-2.0', 'https://github.com/GoogleChromeLabs/squoosh', 'npm:@jsquash/resize/lib/resize/LICENSE.codec.md']],
    source: `import init, { resize } from "@jsquash/resize/lib/resize/pkg/squoosh_resize.js";
${IMAGE_DATA}
/* Lanczos3, alpha premultiplied, in linear light: Squoosh's own defaults. */
codecs.resize = { init: bytes => init(bytes), resize: (rgba, width, height, toWidth, toHeight) => resize(bytesOf(rgba), width, height, toWidth, toHeight, 3, true, true) };`
  },
  mp3: {
    upstream: [['mpg123', 'LGPL-2.1-or-later', 'https://www.mpg123.de/', 'madebr/mpg123/master/COPYING',
      'codecs/mp3.js is a file of its own, loaded only to read mp3, and may be replaced with a build of a changed mpg123; the source is at https://www.mpg123.de/ and the build at https://github.com/eshaz/wasm-audio-decoders'], EMSCRIPTEN],
    source: AUDIO('mp3', 'mpg123-decoder', 'MPEGDecoder')
  },
  flac: { upstream: [XIPH('FLAC', 'flac', 'master/COPYING.Xiph'), EMSCRIPTEN], source: AUDIO('flac', '@wasm-audio-decoders/flac', 'FLACDecoder') },
  vorbis: {
    upstream: [XIPH('Vorbis', 'vorbis', 'master/COPYING'), XIPH('Ogg', 'ogg', 'master/COPYING'), EMSCRIPTEN],
    source: AUDIO('vorbis', '@wasm-audio-decoders/ogg-vorbis', 'OggVorbisDecoder')
  },
  opus: { upstream: [XIPH('Opus', 'opus', 'main/COPYING'), EMSCRIPTEN], source: AUDIO('opus', 'ogg-opus-decoder', 'OggOpusDecoder') },
  mux: { upstream: [], source: MUX },
  'mp3-encode': {
    upstream: [['LAME', 'LGPL-2.0-or-later', 'https://lame.sourceforge.io/', 'lameproject/lame/master/COPYING',
      'codecs/mp3-encode.js is a file of its own, loaded only to make mp3, and may be replaced with a build of a changed LAME; the source is at https://lame.sourceforge.io/ and the build at https://github.com/Vanilagy/mediabunny/tree/main/packages/mp3-encoder'], EMSCRIPTEN],
    plugins: [muxGlobal],
    source: `import { registerMp3Encoder } from "@mediabunny/mp3-encoder";
let registered = false;
(globalThis.eyesCodecs = globalThis.eyesCodecs || {})["mp3-encode"] = {
  init: () => { if (!registered) { registerMp3Encoder(); registered = true; } return Promise.resolve(); }
};`
  }
};

/* Left out of the audio decoders: their web-worker variants, which subclass a
   Worker when they load, and Opus's optional speech-enhancement model (4 MB),
   neither of which the tools use. */
const unused = {
  name: 'unused',
  setup(build) {
    build.onResolve({ filter: /^(@eshaz\/web-worker|@wasm-audio-decoders\/opus-ml)$/ }, args => ({ path: args.path, namespace: 'unused' }));
    build.onLoad({ filter: /.*/, namespace: 'unused' }, args => ({
      loader: 'js',
      contents: args.path === '@eshaz/web-worker' ? 'module.exports = function Worker() { throw new Error("web workers are not used here"); };' : 'module.exports = {};'
    }));
  }
};

/* Notes the notices print with an npm package. */
const NOTES = {
  'codec-parser': 'bundled into codecs/flac.js, vorbis.js and opus.js, files of their own that load only to read those formats; ' +
    'scripts/vendor.mjs rebuilds them with a changed codec-parser, whose source is at https://github.com/eshaz/codec-parser'
};

/* Packages that ship a prebuilt bundle with no source map to say what it
   holds: their notices cover everything they depend on instead. */
const UNMAPPED = ['@prettier/plugin-php', 'prettier-plugin-latex'];

const LICENSE_FILE = /^(licen[cs]e|copying|notice|third-party-notices)/i;
const curl = (url, file) => execFileSync('curl', ['-fsSL', '--retry', '3', url, ...(file ? ['-o', file] : [])],
  { encoding: file ? undefined : 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] });

const work = mkdtempSync(join(tmpdir(), 'eyes-vendor-'));
try {
  writeFileSync(join(work, 'package.json'), JSON.stringify({ private: true, dependencies: VERSIONS }, null, 2));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: work, stdio: 'inherit' });
  const modules = join(work, 'node_modules');
  const require = createRequire(join(work, 'package.json'));
  const esbuild = require('esbuild');
  const manifest = dir => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));

  /* Everything a vendored file contains, for its folder's NOTICES.txt: each
     component once, with its license and where its source is. */
  const components = new Map();
  /* A package's license files; one that ships none, its repository's. */
  const repositories = new Map();
  const licenseTexts = (dir, repository) => {
    const texts = readdirSync(dir).filter(f => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile()).sort()
      .map(f => [f, readFileSync(join(dir, f), 'utf8')]);
    const github = /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?(?:[/#]|$)/.exec(repository || '');
    if (texts.length || !github) return texts;
    if (!repositories.has(github[1])) repositories.set(github[1], ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'LICENSE-APACHE'].flatMap(f => {
      try { return [[`${f} in ${github[1]}`, curl(`https://raw.githubusercontent.com/${github[1]}/HEAD/${f}`)]]; } catch { return []; }
    }));
    return repositories.get(github[1]);
  };
  const npmPackage = dir => {
    const { name, version, license, repository } = manifest(dir);
    const key = `npm:${name}@${version}`;
    if (!components.has(key)) components.set(key, {
      name: `${name} ${version}`, license: typeof license === 'string' ? license : license && license.type,
      source: `https://www.npmjs.com/package/${name}/v/${version}`, note: NOTES[name],
      texts: licenseTexts(dir, typeof repository === 'string' ? repository : repository && repository.url)
    });
    return key;
  };
  const crate = (name, ver) => {
    const key = `crate:${name}@${ver}`;
    if (!components.has(key)) {
      const dir = join(work, 'crates');
      const file = join(dir, `${name}-${ver}.crate`);
      mkdirSync(dir, { recursive: true });
      curl(`https://static.crates.io/crates/${name}/${name}-${ver}.crate`, file);
      execFileSync('tar', ['-xzf', file, '-C', dir]);
      const src = join(dir, `${name}-${ver}`);
      const cargo = readFileSync(join(src, 'Cargo.toml'), 'utf8');
      const field = entry => (new RegExp(`^${entry}\\s*=\\s*"([^"]*)"`, 'm').exec(cargo) || [])[1];
      components.set(key, {
        name: `${name} ${ver} (Rust crate)`, license: field('license'),
        source: `https://crates.io/crates/${name}/${ver}`, texts: licenseTexts(src, field('repository'))
      });
    }
    return key;
  };
  const upstream = ([name, license, repo, file, note]) => {
    const key = 'upstream:' + name;
    if (!components.has(key)) {
      const text = file.startsWith('npm:') ? readFileSync(join(modules, file.slice(4)), 'utf8') : curl('https://raw.githubusercontent.com/' + file);
      components.set(key, { name, license, source: repo, note, texts: [[file.split('/').pop(), text]] });
    }
    return key;
  };
  /* A Rust build names the crates it compiled in the paths its panics print. */
  const crates = wasm => {
    const binary = readFileSync(join(modules, wasm)).toString('latin1');
    const found = [...binary.matchAll(/registry\/src\/[^/]+\/([A-Za-z0-9_-]+?)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?(?:\+[0-9A-Za-z.]+)?)\//g)]
      .map(([, crateName, crateVersion]) => crateName + '@' + crateVersion);
    return [...new Set(found)].sort().map(id => crate(...id.split('@')));
  };
  const packageDir = file => /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(file)[1];
  const installed = (owner, name) => {
    const dir = [join(owner, 'node_modules', name), join(modules, name)].find(dir => existsSync(join(dir, 'package.json')));
    if (!dir) throw new Error(`${name}, which ${owner} bundles, is not installed`);
    return dir;
  };
  const dependencies = (dir, found = new Map()) => {
    for (const name of Object.keys(manifest(dir).dependencies || {})) {
      if (name === 'prettier' || found.has(name)) continue;
      found.set(name, installed(dir, name));
      dependencies(found.get(name), found);
    }
    return found;
  };
  /* A package that ships a prebuilt bundle names what it bundled in the
     bundle's source map; one in UNMAPPED, by what it depends on. Each is read
     where npm installed it. */
  const bundledIn = file => {
    const owner = packageDir(file);
    if (UNMAPPED.includes(manifest(owner).name)) return [...dependencies(owner).values()].map(npmPackage);
    const map = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(readFileSync(file, 'utf8'));
    if (!map || map[1].startsWith('data:') || !existsSync(join(dirname(file), map[1]))) return [];
    const names = JSON.parse(readFileSync(join(dirname(file), map[1]), 'utf8')).sources
      .map(source => /^.*node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(source)).filter(Boolean).map(match => match[1]);
    return [...new Set(names)].map(name => npmPackage(installed(owner, name)));
  };

  /* Imports of Prettier inside a bundled plugin, answered by the globals. */
  const prettierGlobals = {
    name: 'prettier-globals',
    setup(build) {
      build.onResolve({ filter: /^prettier(\/.*)?$/ }, args => ({ path: args.path, namespace: 'prettier-global' }));
      build.onLoad({ filter: /.*/, namespace: 'prettier-global' }, args => {
        const target = args.path.startsWith('prettier/plugins/') ? `globalThis.prettierPlugins.${args.path.slice(17).replace(/\.js$/, '')}`
          : /^prettier\/doc(\.js)?$/.test(args.path) ? 'globalThis.prettier.doc' : 'globalThis.prettier';
        return { contents: `module.exports = ${target};`, loader: 'js' };
      });
    }
  };
  /* The bundle, and the npm packages esbuild read to make it. Every module is
     handed its WebAssembly, so the URL it would find its own .wasm by is never
     used; an Emscripten build parses one as it loads, so a codec gets a base
     that parses. */
  const bundle = async (source, { plugins = [], base = '' } = {}) => {
    const result = await esbuild.build({
      stdin: { contents: source, resolveDir: work, loader: 'js' }, absWorkingDir: work, metafile: true,
      bundle: true, format: 'iife', minify: true, write: false, legalComments: 'none',
      target: 'es2020', platform: 'browser', plugins, logLevel: 'error',
      define: { 'import.meta.url': JSON.stringify(base) }
    });
    const inputs = Object.keys(result.metafile.inputs).map(input => join(work, input)).filter(file => file.includes('/node_modules/'));
    return { code: result.outputFiles[0].text, packages: inputs.flatMap(file => [npmPackage(packageDir(file)), ...bundledIn(file)]) };
  };

  /** One vendored folder: where it is, its files' headers, and what they hold. */
  const folder = name => {
    const out = join(root, name);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    const contents = [];
    return {
      name, out, contents,
      header: pkg => {
        const { version, license } = manifest(join(modules, pkg));
        return `/*! ${pkg} ${version} (${license}), vendored by scripts/vendor.mjs. Notices: ${name}/NOTICES.txt. */\n`;
      },
      record: (files, keys) => contents.push([files.map(f => name + '/' + f), [...new Set(keys)]]),
      /* A prebuilt file, copied: what it holds is its package and what it bundled. */
      copy(file, from) {
        const path = join(modules, from);
        writeFileSync(join(out, file), this.header(manifest(packageDir(path)).name) + readFileSync(path, 'utf8'));
        return [npmPackage(packageDir(path)), ...bundledIn(path)];
      }
    };
  };

  /** NOTICES.txt: what each file holds, then each license text once, headed by
      everything in the folder that ships it. */
  const notices = (place, title, intro) => {
    const lines = [title, '='.repeat(title.length), '', ...intro, '', '', 'What each file contains', '-----------------------'];
    const used = new Map();
    for (const [files, keys] of place.contents) {
      lines.push('', files.join(', '));
      for (const key of keys) {
        const component = components.get(key);
        used.set(key, component);
        lines.push(`  ${component.name}, ${component.license || 'license in its files'}: ${component.source}`);
        if (component.note) lines.push(`    ${component.note}`);
      }
    }
    const texts = new Map();
    const bare = [];
    for (const { name, license, texts: files } of used.values()) {
      if (!files.length) bare.push(`${name} (${license})`);
      for (const [file, text] of files) {
        const body = text.replace(/\r\n?/g, '\n').trim();
        if (!texts.has(body)) texts.set(body, []);
        texts.get(body).push(`${name}, ${file}`);
      }
    }
    lines.push('', '', 'License texts', '-------------');
    if (bare.length) lines.push('', 'These ship no license file of their own, only the license their package', 'names: ' + bare.join(', ') + '.');
    for (const [body, owners] of texts) lines.push('', '', '== ' + owners.join('; ') + ' ==', '', body);
    writeFileSync(join(place.out, 'NOTICES.txt'), lines.join('\n') + '\n');

    const files = readdirSync(place.out).sort();
    for (const file of files) console.log(`${String(statSync(join(place.out, file)).size).padStart(9)}  ${place.name}/${file}`);
    console.log(`wrote ${files.length} files to ${place.name}/, with notices for ${used.size} components`);
    if (bare.length) console.log('no license file of their own: ' + bare.join(', '));
  };

  /* ── fmt/ ── */
  const fmt = folder('fmt');
  fmt.record(['prettier.js', ...PRETTIER_UMD.map(name => `prettier-${name}.js`)], [fmt.copy('prettier.js', 'prettier/standalone.js'),
    ...PRETTIER_UMD.map(name => fmt.copy(`prettier-${name}.js`, `prettier/plugins/${name}.js`))].flat());
  fmt.record(['prettier-php.js'], fmt.copy('prettier-php.js', '@prettier/plugin-php/standalone.js'));
  for (const [name, entry] of Object.entries(PRETTIER_BUNDLED)) {
    const pkg = entry.startsWith('@') ? entry.split('/').slice(0, 2).join('/') : entry.split('/')[0];
    const { code, packages } = await bundle(`import * as plugin from ${JSON.stringify(entry)};
      const found = plugin.default && plugin.default.parsers ? plugin.default : plugin;
      globalThis.prettierPlugins = globalThis.prettierPlugins || {};
      globalThis.prettierPlugins[${JSON.stringify(name)}] = found;`, { plugins: [prettierGlobals] });
    writeFileSync(join(fmt.out, `prettier-${name}.js`), fmt.header(pkg) + code);
    fmt.record([`prettier-${name}.js`], packages);
  }
  fmt.record(['sql-formatter.js'], fmt.copy('sql-formatter.js', 'sql-formatter/dist/sql-formatter.min.js'));
  for (const [name, [entry, wasm]] of Object.entries(WASM)) {
    const pkg = entry.split('/').slice(0, 2).join('/');
    const { code, packages } = await bundle(`import init, * as formatter from ${JSON.stringify(entry)};
      globalThis.wasmFmt = globalThis.wasmFmt || {};
      globalThis.wasmFmt[${JSON.stringify(name)}] = { init: init, format: formatter.format };`);
    writeFileSync(join(fmt.out, `${name}.js`), fmt.header(pkg) + code);
    copyFileSync(join(modules, wasm), join(fmt.out, `${name}.wasm`));
    fmt.record([`${name}.js`, `${name}.wasm`], [...packages, ...UPSTREAM[name].map(upstream), ...crates(wasm)]);
  }
  notices(fmt, 'Notices for the formatters in fmt/', [
    'clean code loads these files the first time a language needs one.',
    'scripts/vendor.mjs makes them from the npm packages named below; a',
    'WebAssembly build also compiles the projects and Rust crates named with',
    'it. Each keeps its own license. The license texts follow the list, each',
    'once, headed by everything that ships it, and each component\'s source is',
    'at the address given with it.'
  ]);

  /* ── codecs/ ── */
  const codecs = folder('codecs');
  for (const [name, { wasm, upstream: compiled, source, plugins = [] }] of Object.entries(CODECS)) {
    const { code, packages } = await bundle(source, { plugins: [unused, ...plugins], base: 'file:///' });
    const owner = packages.map(key => components.get(key).name.split(' ')[0]).find(pkg => pkg in VERSIONS);
    writeFileSync(join(codecs.out, `${name}.js`), codecs.header(owner) + code);
    if (wasm) copyFileSync(join(modules, wasm), join(codecs.out, `${name}.wasm`));
    codecs.record(wasm ? [`${name}.js`, `${name}.wasm`] : [`${name}.js`], [...packages, ...compiled.map(upstream), ...(wasm ? crates(wasm) : [])]);
  }
  notices(codecs, 'Notices for the codecs in codecs/', [
    'The tools that take or give an image or a sound load these files where a',
    'browser\'s own codecs are not there to ask, as on the MCP server, and the',
    'downloader loads the muxer to join streams: each the first time a file',
    'needs it. scripts/vendor.mjs makes them from the npm',
    'packages named below; a WebAssembly build also compiles the projects and',
    'Rust crates named with it. Each keeps its own license. The license texts',
    'follow the list, each once, headed by everything that ships it, and each',
    'component\'s source is at the address given with it.'
  ]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
