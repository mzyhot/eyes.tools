/* 𓁹𓁹 — shared runtime.
 *
 * A classic script: no bundler, no modules, no dependencies. Every page loads
 * this file directly and the site must keep working from `file://`, so nothing
 * here may assume a server, a build step, or modern syntax that older mobile
 * browsers reject.
 *
 * The file exposes exactly one global, `E`, documented in `_dev/CONTRACT.md`
 * section 6. Tool pages are forbidden from editing this file, which makes `E`
 * a frozen public interface: add to it, never reshape it.
 *
 * Responsibilities, in load order:
 *   1. DOM helpers (`qs`, `qsa`, `on`, `el`, `esc`, `debounce`).
 *   2. Feedback and export helpers (`flash`, `copy`, `download`, `fail`, `bytes`).
 *   3. Randomness and URL-state helpers (`rand`, `param`, `b64url`).
 *   4. Theme persistence, applied before paint by `theme.js` and kept in sync
 *      across tabs here.
 *   5. `boot()`, which builds every page's chrome — the head tags, the header,
 *      the title block and the footer — from `site.js` and `tools.js`, then
 *      loads the scripts the registry lists for this tool and runs the page's
 *      own code through `E.tool`.
 *
 * A page therefore contains its `<main>` and one script, and nothing else. To
 * change the chrome everywhere, change `site.js`; to change one tool's header,
 * lede, dependencies or footer note, change its row in `tools.js`.
 */
(function () {
  "use strict";

  var E = {};
  var SITE = window.SITE || {};
  var LABELS = SITE.labels || {};

  /* ── dom ─────────────────────────────────────────────── */

  /**
   * querySelector, scoped to `root` when given.
   * @param {string} sel CSS selector.
   * @param {ParentNode} [root=document] Subtree to search.
   * @returns {Element|null}
   */
  E.qs = function (sel, root) { return (root || document).querySelector(sel); };

  /**
   * querySelectorAll as a real array, so `map`/`filter`/`forEach` are available
   * and the result does not stay live against later DOM mutation.
   * @param {string} sel CSS selector.
   * @param {ParentNode} [root=document] Subtree to search.
   * @returns {Element[]}
   */
  E.qsa = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /**
   * addEventListener that tolerates a missing element, so callers can wire a
   * control that only some pages render without guarding every call.
   * @param {EventTarget|null} el Target, or null to do nothing.
   * @param {string} ev Event name.
   * @param {EventListener} fn Handler.
   * @param {boolean|AddEventListenerOptions} [opts] Listener options.
   * @returns {EventTarget|null} The target, for chaining.
   */
  E.on = function (el, ev, fn, opts) { if (el) el.addEventListener(ev, fn, opts); return el; };

  /* Property names routed through setAttribute rather than assigned directly.
     `class` and `text` are convenience aliases; `role`, `data-*` and `aria-*`
     have no DOM property on every engine the site supports. */
  var ATTR_PREFIX = /^(?:data|aria)-/;

  /**
   * Element factory. Keeps tool pages off `innerHTML`, which is the only
   * practical way to guarantee the contract's "treat all user input as hostile"
   * rule across thirty independently written pages.
   * @param {string} tag Tag name.
   * @param {Object<string, *>} [props] `class`, `text`, any `data-*`/`aria-*`/
   *   `role` attribute, or any assignable DOM property (`href`, `type`, `id`…).
   * @param {Array<Node|string>} [kids] Children; strings become text nodes.
   * @returns {Element}
   */
  E.el = function (tag, props, kids) {
    var n = document.createElement(tag), k, i;
    if (props) {
      for (k in props) {
        if (k === "class") n.className = props[k];
        else if (k === "text") n.textContent = props[k];
        else if (k === "role" || ATTR_PREFIX.test(k)) n.setAttribute(k, props[k]);
        else n[k] = props[k];
      }
    }
    if (kids) {
      for (i = 0; i < kids.length; i++) {
        n.appendChild(typeof kids[i] === "string" ? document.createTextNode(kids[i]) : kids[i]);
      }
    }
    return n;
  };

  /* Hoisted so escaping a large string does not allocate a fresh lookup object
     for every character it replaces. */
  var ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  var ESCAPE_RE = /[&<>"']/g;
  function escapeChar(c) { return ESCAPES[c]; }

  /**
   * HTML-escape a value for interpolation into markup. Prefer `textContent` or
   * `E.el`; use this only when markup genuinely has to be built as a string.
   * @param {*} s Value; coerced with String().
   * @returns {string}
   */
  E.esc = function (s) {
    return String(s).replace(ESCAPE_RE, escapeChar);
  };

  /**
   * Fill `{name}` placeholders in a string from `site.js`, so copy that varies
   * by state is still written in one place.
   * @param {string} template Text containing `{name}` markers.
   * @param {Object<string, *>} values Replacements.
   * @returns {string}
   */
  E.fill = function (template, values) {
    return String(template == null ? "" : template).replace(/\{(\w+)\}/g, function (match, key) {
      return Object.prototype.hasOwnProperty.call(values || {}, key) ? String(values[key]) : match;
    });
  };

  /**
   * Trailing debounce: the wrapped function runs once `ms` have passed with no
   * further calls. Used to keep live `input` handlers off the main thread for
   * work heavier than a few hundred microseconds.
   * @param {Function} fn Function to defer.
   * @param {number} [ms=120] Quiet period in milliseconds.
   * @returns {Function} Wrapper preserving `this` and arguments.
   */
  E.debounce = function (fn, ms) {
    var t;
    if (ms == null) ms = 120;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  };

  /* ── feedback: silent success, label swap, no toasts ─── */

  /**
   * Temporarily replace a button's label, then restore it. This is the site's
   * only success signal — the contract forbids toasts.
   *
   * Re-entrant calls are ignored while a flash is in flight so a double click
   * cannot capture the temporary label as the permanent one.
   * @param {HTMLElement|null} btn Button to relabel.
   * @param {string} label Temporary label.
   * @param {number} [ms=1100] How long to show it.
   */
  E.flash = function (btn, label, ms) {
    if (!btn || btn.dataset.flashing) return;
    var prev = btn.textContent;
    btn.dataset.flashing = "1";
    btn.textContent = label;
    setTimeout(function () {
      btn.textContent = prev;
      delete btn.dataset.flashing;
    }, ms || 1100);
  };

  /**
   * Write text to the clipboard and confirm on the button that asked for it.
   *
   * Tries the async Clipboard API first, then falls back to a hidden textarea
   * and `execCommand("copy")` — still the only path that works from `file://`
   * and in browsers that refuse clipboard permission to insecure origins.
   * @param {*} text Value to copy; coerced with String().
   * @param {HTMLElement} [btn] Button to relabel with the outcome.
   * @returns {Promise<boolean>} Whether the text reached the clipboard.
   */
  E.copy = function (text, btn) {
    text = String(text == null ? "" : text);
    var done = function () { E.flash(btn, "copied"); };
    var fail = function () {
      if (!btn) return;
      btn.dataset.state = "error";
      E.flash(btn, "copy failed");
      setTimeout(function () { delete btn.dataset.state; }, 1200);
    };
    if (!text) { E.flash(btn, "nothing to copy"); return Promise.resolve(false); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        return Promise.resolve(navigator.clipboard.writeText(text)).then(function () { done(); return true; },
          function () {
            if (legacy()) { done(); return true; }
            fail();
            return false;
          });
      } catch (e) {
        return Promise.resolve(legacy() ? (done(), true) : (fail(), false));
      }
    }
    return Promise.resolve(legacy() ? (done(), true) : (fail(), false));

    /* Synchronous fallback. Must run inside the originating user gesture, so it
       cannot be deferred: it selects an off-screen textarea, copies, removes it,
       and hands focus back to whatever the visitor was using. */
    function legacy() {
      var ta, active = document.activeElement;
      try {
        ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        return document.execCommand("copy");
      } catch (e) { return false; }
      finally {
        if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
        if (active && typeof active.focus === "function") active.focus({ preventScroll: true });
      }
    }
  };

  /**
   * Save data to the visitor's disk through a synthetic anchor.
   *
   * The object URL is revoked on a delay rather than immediately: Safari reads
   * the blob asynchronously after the click and produces an empty file if the
   * URL is released in the same task.
   * @param {Blob|string|BufferSource} data Payload; non-Blobs are wrapped.
   * @param {string} [filename="download"] Suggested filename.
   * @param {string} [mime="text/plain;charset=utf-8"] Type for non-Blob data.
   */
  E.download = function (data, filename, mime) {
    var blob;
    if (data instanceof Blob) blob = data;
    else blob = new Blob([data], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  };

  /**
   * Write an error message into an `.err` element, or clear it. The contract
   * wants errors quiet and specific, so the message is the whole treatment.
   * @param {Element|string|null} elOrSel Element or a selector for one.
   * @param {string} [msg=""] Message; empty string clears and hides the element.
   */
  E.fail = function (elOrSel, msg) {
    var el = typeof elOrSel === "string" ? E.qs(elOrSel) : elOrSel;
    if (el) el.textContent = msg || "";
  };

  var KB = 1024, MB = 1048576, GB = 1073741824;

  /**
   * Format a byte count for display. Binary units, one unit step per magnitude,
   * chosen so a size never needs more than four significant figures.
   * @param {number} n Bytes.
   * @returns {string} e.g. "1.5 KB".
   */
  E.bytes = function (n) {
    if (n < KB) return n + " B";
    if (n < MB) return (n / KB).toFixed(1) + " KB";
    if (n < GB) return (n / MB).toFixed(2) + " MB";
    return (n / GB).toFixed(2) + " GB";
  };

  /**
   * Cryptographically strong random bytes.
   *
   * Capped at one `getRandomValues` quota (65536 bytes) because the Web Crypto
   * API throws above it; callers that need more must loop.
   * @param {number} n Byte count, 0…65536.
   * @returns {Uint8Array}
   * @throws {Error} If the count is invalid or Web Crypto is unavailable.
   */
  E.rand = function (n) {
    n = Number(n);
    if (!Number.isSafeInteger(n) || n < 0 || n > 65536) throw new Error("invalid random byte count");
    var a = new Uint8Array(n);
    var source = window.crypto || window.msCrypto;
    if (!source || typeof source.getRandomValues !== "function") throw new Error("Web Crypto API is unavailable");
    source.getRandomValues(a);
    return a;
  };

  /* ── url state: ?q= / #payload ───────────────────────── */

  /**
   * Read one query-string parameter. Never throws — a malformed URL simply has
   * no parameters. Tools prefill from this; they never write to it automatically.
   * @param {string} k Parameter name.
   * @returns {string|null}
   */
  E.param = function (k) {
    try { return new URLSearchParams(location.search).get(k); } catch (e) { return null; }
  };

  /**
   * URL-safe base64 of a UTF-8 string, both directions. Unlike bare
   * `btoa`/`atob` this round-trips any Unicode, and the output is safe in a
   * query string or fragment without further escaping.
   */
  E.b64url = {
    /**
     * @param {string} str Text to encode.
     * @returns {string} Base64url, unpadded.
     */
    enc: function (str) {
      var bytes = new TextEncoder().encode(str), bin = "", i;
      /* Build the binary string in blocks: String.fromCharCode.apply over the
         whole array overflows the argument limit on large inputs, and appending
         one character at a time is markedly slower than appending one block. */
      for (i = 0; i < bytes.length; i += 8192) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      }
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    /**
     * @param {string} s Base64url text, padded or not.
     * @returns {string} The decoded UTF-8 text.
     * @throws {Error} On invalid base64 or invalid UTF-8.
     */
    dec: function (s) {
      s = String(s).replace(/-/g, "+").replace(/_/g, "/");
      while (s.length % 4) s += "=";
      var bin = atob(s), bytes = new Uint8Array(bin.length), i;
      for (i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }
  };

  /* ── where the site's own files are ──────────────────── */

  /* One page may sit at `/case`, at `t/case.html` on disk, or — for the 404 —
     at any address at all. Everything the chrome links to is resolved through
     these two values rather than written into thirty files. */
  var FROM_DISK = location.protocol === "file:";
  var IN_TOOLS_DIR = !!(document.body && document.body.dataset.tool);

  /** The prefix that reaches a published root file, such as `qrcode.min.js`. */
  E.base = FROM_DISK ? (IN_TOOLS_DIR ? "../" : "") : "/";
  /** The index's address from wherever this page is. */
  E.home = FROM_DISK ? E.base + "index.html" : "/";
  /** A tool's address from wherever this page is. */
  E.toolHref = function (slug) { return FROM_DISK ? E.base + "t/" + slug + ".html" : E.base + slug; };

  /* ── theme ───────────────────────────────────────────── */

  /* `theme.js` has already applied the stored choice in the head, before the
     first paint. The code below owns everything after that: toggling, the
     address-bar colour, and mirroring a change made in another tab. */
  var KEY = (SITE.storage && SITE.storage.theme) || "eyes.theme";
  var DEFAULT_THEME = (SITE.storage && SITE.storage.themeDefault) || "dark";
  var THEME_COLOR = SITE.themeColor || {};

  /** @returns {"dark"|"light"} The theme in force right now. */
  function currentTheme() {
    var set = document.documentElement.getAttribute("data-theme");
    return set === "light" || set === "dark" ? set : DEFAULT_THEME;
  }

  /* Keep every theme button describing what it will do, not what is selected —
     the label is the same on both themes, so only the accessible name carries
     the state. */
  function syncThemeControls() {
    var current = currentTheme(), next = current === "dark" ? "light" : "dark";
    var label = E.fill(LABELS.themeSwitch || "Switch to {next} mode", { next: next });
    E.qsa("[data-theme-toggle]").forEach(function (b) {
      b.textContent = LABELS.theme || "theme";
      b.setAttribute("aria-label", label + E.fill(LABELS.themeCurrent || "", { current: current }));
      b.title = label;
    });
  }

  /* Apply a stored preference. With none stored the attribute is removed, which
     leaves the default palette tokens.css defines on :root — the site does not
     follow the system setting. */
  function applyTheme(value) {
    if (value === "dark" || value === "light") document.documentElement.setAttribute("data-theme", value);
    else document.documentElement.removeAttribute("data-theme");
    var meta = E.qsa('meta[name="theme-color"]');
    if (!meta.length) {
      meta.push(E.el("meta", { name: "theme-color" }));
      document.head.appendChild(meta[0]);
    }
    /* Any `media` condition is dropped so a browser never picks a colour for a
       theme that is not shown. */
    meta.forEach(function (m) {
      m.removeAttribute("media");
      m.content = THEME_COLOR[currentTheme()] || "";
    });
    syncThemeControls();
  }

  /** Theme preference, persisted in localStorage under `SITE.storage.theme`. */
  E.theme = {
    /** @returns {"dark"|"light"|null} The stored choice, or null for the default. */
    get: function () { try { return localStorage.getItem(KEY); } catch (e) { return null; } },
    /** @param {"dark"|"light"|null} v Choice to store; falsy clears it. */
    set: function (v) {
      try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) {}
      applyTheme(v);
    },
    /** Flip between dark and light, storing the result. */
    toggle: function () {
      E.theme.set(currentTheme() === "dark" ? "light" : "dark");
    }
  };

  /* The wordmark stays as the literal Unicode text from `site.js`. Redrawing or
     animating it would make it differ from U+13079. This hook only marks the
     element as processed and names it for assistive technology. */
  E.eyes = function (host) {
    if (!host) return;
    host.dataset.built = "1";
    if (host.tagName === "A" && !host.hasAttribute("aria-label")) {
      host.setAttribute("aria-label", LABELS.homeAria || SITE.wordmark || "");
    }
  };

  /* ── the chrome every page shares ────────────────────── */

  /* The registry entry for this page, or null on the index and the 404. */
  function registryEntry() {
    var slug = document.body.dataset.tool;
    if (!slug || !window.TOOLS) return null;
    return window.TOOLS.filter(function (t) { return t.slug === slug; })[0] || null;
  }

  /** Title, description and icon, from the registry or `site.js`. */
  function buildHead(entry, kind) {
    var copy = kind === "not-found" ? SITE.notFound || {} : null;
    document.title = entry ? entry.name + (SITE.titleSuffix || "")
      : copy ? copy.title + (SITE.titleSuffix || "") : SITE.title || "";
    var description = entry ? entry.meta || entry.desc : copy ? null : SITE.description;
    if (description && !E.qs('meta[name="description"]')) {
      document.head.appendChild(E.el("meta", { name: "description", content: description }));
    }
    if (SITE.icon && !E.qs('link[rel="icon"]')) {
      document.head.appendChild(E.el("link", { rel: "icon", type: "image/svg+xml", href: E.base + SITE.icon }));
    }
  }

  /** The wordmark, breadcrumb and theme toggle. */
  function buildHeader(entry, kind) {
    var wordmark = E.el("a", { class: kind === "tool" ? "eyes" : "eyes eyes--lg", href: E.home, "data-eyes": "", text: SITE.wordmark || "" });
    var parts = [wordmark];
    if (entry) {
      var crumb = E.el("p", { class: "crumb" }, ["/ "]);
      crumb.appendChild(E.el("b", { text: entry.name }));
      parts.push(crumb);
    }
    parts.push(E.el("span", { class: "top__spacer" }));
    parts.push(E.el("button", { class: "tbtn", type: "button", "data-theme-toggle": "", text: LABELS.theme || "theme" }));
    return E.el("header", { class: kind === "index" ? "top directory-top" : "top" }, parts);
  }

  /** The `<h1>` and lede above a tool, from the registry. */
  function buildTitleBlock(entry) {
    return E.el("div", { class: "head" }, [
      E.el("h1", { class: "h1", text: entry.name }),
      E.el("p", { class: "lede", text: entry.desc })
    ]);
  }

  /** The footer: the way back, and what the page does with your data. */
  function buildFooter(entry, kind) {
    var parts = [];
    if (kind === "tool") parts.push(E.el("a", { href: E.home, text: LABELS.home || "" }));
    parts.push(E.el("span", { class: "row__spacer" }));
    var note = kind === "index" ? (SITE.footer || {}).index : (entry && entry.note) || (SITE.footer || {}).local;
    if (note) parts.push(E.el("span", { text: note }));
    return E.el("footer", { class: kind === "index" ? "foot directory-foot" : "foot" }, parts);
  }

  /** The skip link, which is the first thing a keyboard reaches. */
  function buildSkipLink(main, kind) {
    if (!main.id) main.id = "main-content";
    if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
    var skip = E.el("a", { class: "skip-link", href: "#" + main.id, text: (kind === "index" ? LABELS.skipToTools : LABELS.skipToTool) || "skip" });
    E.on(skip, "click", function (e) {
      e.preventDefault();
      main.focus({ preventScroll: true });
      main.scrollIntoView({ block: "start", behavior: "instant" });
    });
    return skip;
  }

  /** The not-found page's whole content, from `site.js`. */
  function buildNotFound(main) {
    var copy = SITE.notFound || {};
    main.className = "section";
    main.appendChild(E.el("h1", { class: "h1", text: copy.title || "" }));
    main.appendChild(E.el("p", { class: "lede", text: copy.lede || "" }));
    main.appendChild(E.el("p", { class: "mt-6" }, [E.el("a", { class: "btn", href: E.home, text: copy.action || "" })]));
  }

  /**
   * Wrap the page's `<main>` in the shared shell.
   *
   * A page ships its `<main>` and nothing else: no header, no footer, no title
   * block. They are built here so one change in `site.js` reaches every page.
   */
  function buildChrome(entry, kind) {
    var main = E.qs("main");
    if (!main) return null;
    if (kind === "not-found") buildNotFound(main);
    var wrap = E.el("div", { class: kind === "index" ? "wrap directory-wrap" : "wrap" });
    main.parentNode.insertBefore(wrap, main);
    wrap.appendChild(buildHeader(entry, kind));
    if (entry) wrap.appendChild(buildTitleBlock(entry));
    wrap.appendChild(main);
    /* The not-found page is one short message and a way out: it needs neither a
       footer note about data it never sees nor a link that skips past nothing. */
    if (kind !== "not-found") {
      wrap.appendChild(buildFooter(entry, kind));
      document.body.insertBefore(buildSkipLink(main, kind), document.body.firstChild);
    }
    return main;
  }

  /* ── the tool's own script ───────────────────────────── */

  var queued = [], ready = false;

  function runQueued() {
    ready = true;
    while (queued.length) {
      try { queued.shift()(); }
      catch (error) { reportToolError(error); }
    }
    /* The page is fully assembled: chrome built, dependencies loaded, the tool
       run. Tests wait for this rather than guessing how long a dependency
       takes, and a tool can watch for it from another page of its own. */
    document.body.dataset.ready = "1";
  }

  function reportToolError(error) {
    if (window.console && console.error) console.error("tool failed:", error);
    var slot = E.qs(".err");
    if (slot && !slot.textContent) slot.textContent = "this tool could not start in this browser.";
  }

  /** Load one script from the site root and resolve when it has run. */
  function loadScript(name) {
    return new Promise(function (resolve, reject) {
      var tag = E.el("script", { src: E.base + name });
      tag.onload = function () { resolve(); };
      tag.onerror = function () { reject(new Error("could not load " + name)); };
      document.head.appendChild(tag);
    });
  }

  /**
   * Run a tool's code once everything the registry lists for it has loaded.
   *
   * Every tool page's script is wrapped in this call, so a page never writes a
   * `<script src>` of its own: `deps` in `tools.js` decides what it gets.
   * @param {Function} fn The tool, wrapped in its own scope.
   */
  E.tool = function (fn) {
    if (typeof fn !== "function") return;
    if (ready) {
      try { fn(); } catch (error) { reportToolError(error); }
      return;
    }
    queued.push(fn);
  };

  /* ── page boot ───────────────────────────────────────── */

  /* Everything a page gets for free. Runs as soon as this script does, which is
     after the body has been parsed and before the page's own script, so the
     chrome is in place by the time a tool looks at the document. */
  function boot() {
    var entry = registryEntry();
    var kind = entry ? "tool" : document.body.dataset.page === "not-found" ? "not-found" : "index";

    buildHead(entry, kind);
    buildChrome(entry, kind);
    applyTheme(E.theme.get());

    E.qsa("[data-eyes]").forEach(E.eyes);
    E.qsa("[data-theme-toggle]").forEach(function (b) {
      E.on(b, "click", function () { E.theme.toggle(); });
    });

    /* A storage event fires only in the *other* tabs, so this mirrors a toggle
       across every open page without a broadcast channel. */
    E.on(window, "storage", function (e) {
      if (e.key === KEY || e.key === null) applyTheme(E.theme.get());
    });

    /* Declarative copy buttons: <button data-copy="#selector">. The selector is
       resolved at click time so it still works for output rendered later. */
    E.qsa("[data-copy]").forEach(function (b) {
      E.on(b, "click", function () {
        var src = E.qs(b.dataset.copy);
        if (!src) return;
        E.copy("value" in src ? src.value : src.textContent, b);
      });
    });

    /* Escape returns to the index from any tool page. Typing takes precedence:
       the first Escape leaves a field, a second one leaves the tool. Dialogs and
       fullscreen own the key outright — they have their own dismissal. */
    if (kind === "tool" && (SITE.shortcuts || {}).escapeToIndex) {
      E.on(document, "keydown", function (e) {
        if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
        var a = document.activeElement;
        if (document.fullscreenElement || E.qs("dialog[open]")) return;
        if (a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable)) { a.blur(); return; }
        location.href = E.home;
      });
    }

    /* Finally the tool itself, after the scripts its registry row asks for. */
    var deps = (entry && entry.deps) || [];
    if (!deps.length) { runQueued(); return; }
    deps.reduce(function (chain, name) {
      return chain.then(function () { return loadScript(name); });
    }, Promise.resolve()).then(runQueued, function (error) {
      reportToolError(error);
      runQueued();
    });
  }

  window.E = E;
  boot();
})();
