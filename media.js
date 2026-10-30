/* 𓁹𓁹: files, for the tools that take or give them.
 *
 * An agent hands a tool a file as base64, or as a data: URL, in one string;
 * a tool hands one back as { name, mimeType, bytes, data }, data being the
 * base64. The MCP server sends a result's images to the agent as image
 * content rather than as text. This is what those tools share:
 *
 *   Media.bytes(value, label, max)    a string of base64 → Uint8Array
 *   Media.base64(bytes)               the other way
 *   Media.type(bytes)                 a file's media type, from its first bytes
 *   Media.png(rgba, width, height)    → Promise of a PNG's bytes
 *   Media.file(name, type, bytes)     the shape a tool answers a file in
 *   Media.codec(name)                 → Promise of eyesCodecs[name], loaded
 *                                     and started the first time it is asked for
 *   Media.FILE                        the JSON Schema of that answer
 *
 * The PNG writer needs no codec: it compresses with the CompressionStream every
 * browser and Node has. The codecs in codecs/ (see scripts/vendor.mjs) load
 * from the site: through the MCP server's eyesLoadScript and eyesLoadBytes
 * where it runs a tool, and through E.load and fetch on a page.
 *
 * A classic script with no dependencies, defining `Media`.
 */
var Media = (function () {
  "use strict";

  /* Reached through a local name: where a tool runs in a vm context, as on the
     MCP server, each lookup of a global is slow, and the PNG writer makes
     millions. */
  var abs = Math.abs;

  /* The codecs that bring a .wasm of their own; the audio decoders carry theirs. */
  var WASM = { png: 1, "jpeg-decode": 1, "jpeg-encode": 1, "webp-decode": 1, "webp-encode": 1, resize: 1 };

  function megabytes(n) {
    return n >= 1048576 ? Math.round(n / 1048576) + " MB" : Math.round(n / 1024) + " KB";
  }

  /**
   * A file an agent sent, as bytes.
   * @param {string} value Base64 (standard or URL-safe; spaces and line breaks
   *   ignored), or a data: URL with base64 in it.
   * @param {string} label How messages name it, as "image".
   * @param {number} max The most bytes it may decode to.
   * @returns {Uint8Array}
   * @throws {Error} Saying what is wrong, in the site's words.
   */
  function bytes(value, label, max) {
    var text = String(value == null ? "" : value);
    var url = /^data:([^,]*),/.exec(text.slice(0, 256));
    if (url) {
      if (!/;base64$/i.test(url[1])) throw new Error(label + " as a data: URL must be base64 (data:…;base64,…)");
      text = text.slice(url[0].length);
    }
    text = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
    if (!text) throw new Error("give " + label + " as base64");
    if (!/^[A-Za-z0-9+/]+$/.test(text) || text.length % 4 === 1) throw new Error(label + " must be base64, or a data: URL with base64 in it");
    if (Math.floor(text.length * 3 / 4) > max) throw new Error(label + " is too large: the most it may be is " + megabytes(max));
    var binary = atob(text + "===".slice((text.length + 3) % 4)), out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function base64(data) {
    var parts = [];
    for (var at = 0; at < data.length; at += 32768) parts.push(String.fromCharCode.apply(null, data.subarray(at, at + 32768)));
    return btoa(parts.join(""));
  }

  function ascii(data, at, length) {
    return String.fromCharCode.apply(null, data.subarray(at, at + length));
  }

  /**
   * What a file is, told from its first bytes, the way a browser sniffs one.
   * @param {Uint8Array} data
   * @returns {string|null} A media type, or null when nothing here knows it.
   */
  function type(data) {
    var head = ascii(data, 0, 12);
    if (data[0] === 0x89 && head.slice(1, 4) === "PNG") return "image/png";
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
    if (head.slice(0, 4) === "GIF8") return "image/gif";
    if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WEBP") return "image/webp";
    if (head.slice(0, 4) === "RIFF" && head.slice(8, 12) === "WAVE") return "audio/wav";
    if (head.slice(0, 2) === "BM") return "image/bmp";
    if (head.slice(0, 4) === "II*\u0000" || head.slice(0, 4) === "MM\u0000*") return "image/tiff";
    if (head.slice(0, 4) === "fLaC") return "audio/flac";
    if (head.slice(0, 4) === "OggS") return /OpusHead/.test(ascii(data, 0, 64)) ? "audio/opus" : "audio/ogg";
    if (head.slice(0, 3) === "ID3" || (data[0] === 0xff && (data[1] & 0xe6) === 0xe2)) return "audio/mpeg";
    if (data[0] === 0xff && (data[1] & 0xf6) === 0xf0) return "audio/aac";
    if (data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3) return "audio/webm";
    if (head.slice(4, 8) === "ftyp") {
      var brand = head.slice(8, 12);
      if (brand === "avif" || brand === "avis") return "image/avif";
      if (/^(heic|heix|hevc|mif1|msf1)$/.test(brand)) return "image/heic";
      return "audio/mp4";
    }
    if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(ascii(data, 0, 512))) return "image/svg+xml";
    return null;
  }

  /* ── PNG ── */

  var CRC = (function () {
    var table = new Int32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();
  function crc(data, start, end) {
    var c = -1;
    for (var i = start; i < end; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  }

  /* zlib's deflate, which is what PNG keeps its pixels in, read off a stream. */
  function deflate(data) {
    var stream = new CompressionStream("deflate"), writer = stream.writable.getWriter(), reader = stream.readable.getReader();
    var parts = [], size = 0;
    writer.write(data);
    writer.close();
    return (function pump() {
      return reader.read().then(function (step) {
        if (step.done) {
          var out = new Uint8Array(size), at = 0;
          parts.forEach(function (part) { out.set(part, at); at += part.length; });
          return out;
        }
        parts.push(step.value);
        size += step.value.length;
        return pump();
      });
    })();
  }

  /* Each row filtered the way that leaves the least to compress: the usual
     guess, the smallest sum of the filtered bytes taken as signed. */
  function filtered(rgba, width, height) {
    var stride = width * 4, out = new Uint8Array((stride + 1) * height), trial = new Uint8Array(stride);
    for (var y = 0; y < height; y++) {
      var row = y * stride, above = row - stride, best = 0, bestScore = Infinity, at = y * (stride + 1);
      for (var filter = 0; filter < 5; filter++) {
        var score = 0;
        for (var x = 0; x < stride; x++) {
          var value = rgba[row + x], left = x >= 4 ? rgba[row + x - 4] : 0, up = y ? rgba[above + x] : 0, corner = y && x >= 4 ? rgba[above + x - 4] : 0, guess;
          if (filter === 0) guess = 0;
          else if (filter === 1) guess = left;
          else if (filter === 2) guess = up;
          else if (filter === 3) guess = (left + up) >> 1;
          else {
            var p = left + up - corner, pa = abs(p - left), pb = abs(p - up), pc = abs(p - corner);
            guess = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
          }
          var byte = (value - guess) & 0xff;
          trial[x] = byte;
          score += byte < 128 ? byte : 256 - byte;
          if (score >= bestScore) break;
        }
        if (score < bestScore) { bestScore = score; best = filter; out.set(trial, at + 1); }
      }
      out[at] = best;
    }
    return out;
  }

  /**
   * A PNG of 8-bit RGBA pixels.
   * @param {Uint8Array|Uint8ClampedArray} rgba width × height × 4 bytes.
   * @returns {Promise<Uint8Array>}
   */
  function png(rgba, width, height) {
    return deflate(filtered(rgba, width, height)).then(function (pixels) {
      var chunks = [["IHDR", 13], ["IDAT", pixels.length], ["IEND", 0]], size = 8;
      chunks.forEach(function (chunk) { size += 12 + chunk[1]; });
      var out = new Uint8Array(size), view = new DataView(out.buffer), at = 8;
      out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      chunks.forEach(function (chunk) {
        view.setUint32(at, chunk[1]);
        for (var i = 0; i < 4; i++) out[at + 4 + i] = chunk[0].charCodeAt(i);
        var body = at + 8;
        if (chunk[0] === "IHDR") {
          view.setUint32(body, width);
          view.setUint32(body + 4, height);
          out.set([8, 6, 0, 0, 0], body + 8);   /* 8 bits, RGBA, deflate, adaptive filters, no interlace */
        } else if (chunk[0] === "IDAT") out.set(pixels, body);
        view.setUint32(body + chunk[1], crc(out, at + 4, body + chunk[1]));
        at = body + chunk[1] + 4;
      });
      return out;
    });
  }

  /** The shape a tool answers a file in. */
  function file(name, mimeType, data) {
    return { name: name, mimeType: mimeType, bytes: data.length, data: base64(data) };
  }

  /* ── codecs ── */

  function loaders() {
    if (typeof eyesLoadScript === "function") return [eyesLoadScript, eyesLoadBytes];
    if (typeof E !== "undefined" && E.load) {
      return [E.load, function (name) {
        return fetch(E.base + name).then(function (response) {
          if (!response.ok) throw new Error("could not load " + name);
          return response.arrayBuffer();
        }, function () {
          throw new Error("this part of the tool loads from the site; open it on the web or in the app");
        }).then(function (buffer) { return new Uint8Array(buffer); });
      }];
    }
    throw new Error("the codecs cannot be loaded here");
  }
  var started = {};
  /**
   * One of the codecs in codecs/, loaded and started once.
   * @param {string} name As scripts/vendor.mjs names it, such as "jpeg-decode".
   * @returns {Promise<Object>} eyesCodecs[name].
   */
  function codec(name) {
    if (!started[name]) {
      started[name] = Promise.resolve().then(function () {
        var load = loaders();
        return load[0]("codecs/" + name + ".js").then(function () {
          return WASM[name] ? load[1]("codecs/" + name + ".wasm") : undefined;
        }).then(function (wasm) {
          var found = eyesCodecs[name];
          return Promise.resolve(found.init(wasm)).then(function () { return found; });
        });
      }).catch(function (error) { delete started[name]; throw error; });
    }
    return started[name];
  }

  var FILE = {
    type: "object",
    description: "A file. Over MCP it arrives as image content beside this, without data; in the browser, data is its base64.",
    properties: {
      name: { type: "string", description: "A file name to save it under." },
      mimeType: { type: "string", description: "Its media type, such as image/png." },
      bytes: { type: "integer", minimum: 0, description: "Its size." },
      data: { type: "string", contentEncoding: "base64", description: "The file itself, as base64; left out over MCP, where the file is image content." }
    },
    required: ["name", "mimeType", "bytes"],
    additionalProperties: false
  };

  return { bytes: bytes, base64: base64, type: type, png: png, file: file, codec: codec, FILE: FILE };
})();
