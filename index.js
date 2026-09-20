/* 𓁹𓁹 — the index.
 *
 * Builds the filter field, the keyboard hint and the tool list from
 * `window.TOOLS`, and the words around them from `SITE.index`. The page itself
 * is an empty `<main>`: add a row to `tools.js` and it appears here, with no
 * markup to touch.
 *
 * Everything the visitor types runs on the keystroke, so the work per keystroke
 * has to stay trivial:
 *   · the searchable text for each tool is lowercased once, at boot, into INDEX
 *     rather than rebuilt per tool per keystroke;
 *   · the list item for each tool is built once and reused, so filtering
 *     reorders existing nodes instead of destroying and recreating them;
 *   · the reordered nodes go into a DocumentFragment and reach the document in
 *     one append, so the browser lays the list out once;
 *   · moving the cursor touches only the two rows whose state changed.
 */
(function () {
  "use strict";
  var COPY = (window.SITE && window.SITE.index) || {};
  var SHORTCUTS = (window.SITE && window.SITE.shortcuts) || {};
  var main = E.qs("main");

  /* ── markup ──────────────────────────────────────────── */

  main.appendChild(E.el("h1", { class: "vh", text: COPY.heading || "" }));

  var q = E.el("input", {
    class: "field directory-search", id: "q", type: "search", autocomplete: "off", autocorrect: "off",
    spellcheck: false, placeholder: COPY.filterPlaceholder || "", "aria-controls": "list", "aria-describedby": "search-help"
  });
  var clear = E.el("button", { class: "tbtn search-clear", id: "clear-search", type: "button", "aria-label": COPY.clearAria || "", text: COPY.clearLabel || "", hidden: true });
  main.appendChild(E.el("div", { class: "search-wrap", role: "search" }, [
    E.el("label", { class: "vh", htmlFor: "q", text: COPY.filterLabel || "" }), q, clear
  ]));

  if (COPY.keyboardHint && COPY.keyboardHint.length) {
    var hint = E.el("p", { class: "hint keyboard-hint", "aria-hidden": "true" });
    COPY.keyboardHint.forEach(function (pair, at) {
      if (at) hint.appendChild(document.createTextNode(" · "));
      hint.appendChild(E.el("kbd", { class: "kbd", text: pair[0] }));
      hint.appendChild(document.createTextNode(" " + pair[1]));
    });
    main.appendChild(hint);
  }

  main.appendChild(E.el("p", { class: "vh", id: "search-help", text: COPY.help || "" }));
  var status = E.el("p", { class: "vh", id: "search-status", role: "status", "aria-live": "polite", "aria-atomic": "true" });
  main.appendChild(status);

  var list = E.el("ul", { class: "list tool-list section", id: "list", "aria-label": "tools" });
  main.appendChild(list);

  var reset = E.el("button", { class: "tbtn", id: "reset", type: "button", text: COPY.emptyAction || "" });
  var empty = E.el("div", { class: "directory-empty", id: "empty", hidden: true }, [
    E.el("p", { class: "hint", text: COPY.emptyText || "" }), reset
  ]);
  main.appendChild(empty);

  if (COPY.noscript) {
    var noscript = document.createElement("noscript");
    noscript.appendChild(E.el("p", { class: "hint", text: COPY.noscript }));
    main.appendChild(noscript);
  }

  /* The footer's count sits before the shared note. */
  var count = E.el("span", { class: "num", id: "count" });
  var foot = E.qs(".foot");
  if (foot) foot.insertBefore(count, foot.firstChild);

  /* ── filtering ───────────────────────────────────────── */

  var cursor = -1, shown = [], links = [], announcement, marked = null;

  /* One row per tool: the registry entry, its prebuilt <li>, its <a>, and the
     single lowercase string every filter test runs against. */
  var INDEX = window.TOOLS.map(function (t) {
    var a = E.el("a", { class: "item tool-item", href: E.toolHref(t.slug) }, [
      E.el("span", { class: "item__name", text: t.name }),
      E.el("span", { class: "item__desc", text: t.desc })
    ]);
    return {
      tool: t,
      li: E.el("li", {}, [a]),
      a: a,
      haystack: (t.name + " " + t.desc + " " + (t.alias || "")).toLowerCase()
    };
  });
  var TOTAL = INDEX.length;

  /* Keep the typed filter in history state so a back navigation from a tool
     restores the list the visitor was looking at. */
  function remember() {
    try {
      var state = Object.assign({}, history.state || {});
      state.eyesDirectory = { query: q.value };
      history.replaceState(state, "");
    } catch (e) {}
  }

  /* Screen-reader announcements are debounced: typing fires this on every
     keystroke, and an unthrottled live region reads each intermediate result. */
  function announce(message) {
    clearTimeout(announcement);
    announcement = setTimeout(function () { status.textContent = message; }, 160);
  }

  /* Ranking, applied only when something is typed: an exact name first, then a
     name prefix or an exact slug, then everything else. Ties keep registry
     order, which is the editorial order. */
  function rank(entry, term) {
    var name = entry.tool.name;
    if (name === term) return 0;
    if (name.indexOf(term) === 0 || entry.tool.slug === term) return 1;
    return 2;
  }

  function render() {
    var term = q.value.trim().toLowerCase();
    var words = term ? term.split(/\s+/) : [];
    var wordCount = words.length;
    var i, j, entry, keep;

    shown = [];
    for (i = 0; i < TOTAL; i++) {
      entry = INDEX[i];
      keep = true;
      /* Every typed word must appear somewhere in the tool's searchable text.
         An explicit loop lets a miss abandon the entry immediately. */
      for (j = 0; j < wordCount; j++) {
        if (entry.haystack.indexOf(words[j]) === -1) { keep = false; break; }
      }
      if (keep) shown.push(entry);
    }
    if (term) {
      shown.forEach(function (e, at) { e.rank = rank(e, term) * TOTAL + at; });
      shown.sort(function (a, b) { return a.rank - b.rank; });
    }

    var frag = document.createDocumentFragment();
    links = shown.map(function (e) { frag.appendChild(e.li); return e.a; });
    list.textContent = "";
    list.appendChild(frag);

    /* Rows are reused, so the highlight has to be cleared off the node itself;
       detaching it from the list would otherwise leave the class behind. */
    if (marked) marked.classList.remove("is-cursor");
    marked = null;
    cursor = term && shown.length ? 0 : -1;
    empty.hidden = shown.length > 0;
    clear.hidden = !q.value;
    count.textContent = shown.length === TOTAL
      ? E.fill(COPY.count, { count: shown.length })
      : E.fill(COPY.countFiltered, { count: shown.length, total: TOTAL });
    mark();
    announce(shown.length + (shown.length === 1 ? " tool" : " tools") +
      (term ? " matching “" + q.value.trim() + "”." : "."));
    remember();
  }

  /* Move the cursor highlight. Only the row losing it and the row gaining it
     are touched, so arrowing through a long list stays constant-time. */
  function mark() {
    var next = cursor < 0 ? null : links[cursor];
    if (marked === next) return;
    if (marked) marked.classList.remove("is-cursor");
    if (next) next.classList.add("is-cursor");
    marked = next || null;
  }

  function move(d) {
    if (!shown.length) return;
    cursor = cursor < 0 ? (d > 0 ? 0 : shown.length - 1) : (cursor + d + shown.length) % shown.length;
    mark();
    links[cursor].scrollIntoView({ block: "nearest" });
    announce(shown[cursor].tool.name + ", " + (cursor + 1) + " of " + shown.length + ". Press enter to open.");
  }

  E.on(q, "input", render);
  E.on(q, "focus", mark);
  E.on(q, "keydown", function (e) {
    if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      var el = links[cursor < 0 ? 0 : cursor];
      if (el) { e.preventDefault(); location.href = el.href; }
    } else if (e.key === "Escape") {
      /* First Escape clears the filter, a second one releases the field. */
      e.preventDefault();
      if (q.value) { q.value = ""; render(); }
      else { cursor = -1; mark(); q.blur(); }
    }
  });
  E.on(clear, "click", function () { q.value = ""; render(); q.focus(); });
  E.on(reset, "click", function () { q.value = ""; render(); q.focus(); });
  /* Tabbing into the list hands navigation to the browser; drop our cursor so
     two highlights are never visible at once. */
  E.on(list, "focusin", function () { cursor = -1; mark(); });
  /* The filter key focuses the field from anywhere, unless the visitor is
     already typing. */
  if (SHORTCUTS.filterKey) {
    E.on(document, "keydown", function (e) {
      if (e.key !== SHORTCUTS.filterKey || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      e.preventDefault(); q.focus(); q.select();
    });
  }

  try {
    var saved = history.state && history.state.eyesDirectory;
    if (saved) {
      q.value = typeof saved.query === "string" ? saved.query : "";
    }
  } catch (e) {}
  render();
})();
