# 𓁹𓁹 — tool contract

Read this in full before writing a tool page. Every tool on the site is one
HTML file in `t/` holding two things: its `<main>` and its script. There is no
build step, no framework, and no runtime package. Beyond the shared fonts, a
page makes no network requests unless it is a network tool (rule 4).

Everything around the tool — the head tags, the header, the `<h1>`, the lede,
the footer — is built by `s.js` from `site.js` (the site's copy and behaviour)
and the tool's row in `tools.js`. That is why a page never writes them, and why
`npm run check` fails if it does.

**Reference implementation: [`t/case.html`](../t/case.html). Skeleton: [`_dev/TEMPLATE.html`](TEMPLATE.html).**
When in doubt, do what `case.html` does.

---

## 1. Hard rules

1. **One file, one row.** `t/<slug>.html` plus one row in `tools.js`, then
   `node scripts/static-routes.mjs`. Do not change `site.js`, `s.css`, `s.js`,
   another tool, or anything else. If you need something the shared layer
   doesn't offer, implement it locally inside your file.
2. **No CDN runtime dependencies.** No remote scripts, npm runtime, or `import`.
   QR and metadata parsing use vendored browser builds, named in your row's
   `deps` — never in a `<script src>` on the page. The font stylesheet in
   `fonts.css` is the one remote file every page loads. Network tools are
   explicit exceptions: verified randomness contacts Cloudflare's drand relay,
   and share uses the same-origin `/api/share/*` endpoints plus WebRTC.
3. **Classic scripts only.** No `<script type="module">`. The site must work when
   opened straight off disk via `file://`. All paths are relative (`../s.css`).
4. **Local unless the tool says otherwise.** No telemetry or analytics. File
   transforms stay in the browser. A network tool must state what leaves the
   browser and what service or peer receives it.
5. **Tokens only.** Never write a raw colour, `font-family`, or corner radius.
   Use `var(--color-ink)`, `var(--font-mono)`, `var(--space-4)` etc. Inline
   `style=""` is allowed **only** when its values are tokens; prefer the utility
   classes below.
6. **Square corners, hairline rules, no shadows, no gradients, no emoji, no icon
   fonts.** The site's only accent is inversion (ink background, paper text).
7. **Wrap all JS** in `E.tool(function () { "use strict"; ... });` at the bottom
   of the file. Declare no globals. `E.tool` runs your code once the scripts in
   your `deps` have loaded, so they are ready when it starts.

## 2. The page skeleton

Copy `_dev/TEMPLATE.html` and replace `SLUG` in `<body data-tool="…">`. That is
the only edit the skeleton needs: the head, the header and the footer are
identical on every page and come from the shared layer.

Everything you write goes inside `<main class="stack-6">` and the `E.tool(...)`
block at the bottom. A scoped `<style>` in the head is allowed (rule 5).

Your row in `tools.js` carries the rest:

| Field | Becomes |
| --- | --- |
| `name` | the `<h1>`, the breadcrumb, `document.title`, the index |
| `desc` | the lede under the heading, and the index's second column |
| `meta` | the page's `<meta name="description">` |
| `alias` | extra words the index filter matches |
| `deps` | scripts `s.js` loads before running your code |
| `note` | the footer line, for a tool that reaches the network |

Nothing else registers the page. Removing the row and the file removes the
tool.

## 3. UX doctrine

The site's one job is: **the visitor leaves holding a result.**

- **Result-first.** Show output the moment there is enough input. Prefer live
  computation on `input` (debounced with `E.debounce` if the work is heavy) over
  a "Convert" button. A button is fine when the work is genuinely expensive or
  genuinely destructive.
- **Show every useful form at once** rather than making the user pick one from a
  dropdown, when the outputs are small (see `case.html` — eleven results, no
  mode switch). Use a mode switch only when outputs are large or mutually exclusive.
- **Every result is one click from being taken away.** Copy button (`E.copy`) for
  text; download button (`E.download`) for files and images.
- **Empty state is silence,** not an illustration or a paragraph of encouragement.
  `.res__v:empty`, `.out:empty` and an empty `.kv dd` already render an em dash.
- **Deep-link the input where it's cheap.** `E.param("t")` reads `?t=…`; prefill
  from it if present. Never put user data in the URL automatically.
- **Silent success.** No toasts. Confirm by swapping a button label (`E.flash`),
  which `E.copy` already does.
- **Errors are quiet and specific.** Write the message into an `.err` element:
  `unexpected } at line 4`, not `Something went wrong!`. While the visitor is
  still typing, an unfinished input is not yet wrong: hold its error until they
  pause (see `calc.html`).
- **Files can be dropped anywhere.** A file dropped on a tool page lands in its
  one visible file field, as if chosen there, and fires `change`. A page that
  handles drops itself calls `preventDefault()` on `dragover` and `drop`, and
  the shared handler leaves them alone.

## 4. Voice

Lowercase for labels, buttons, and hints. Sentence case for prose. No
exclamation marks, no "Simply", no "Just", no marketing, no invented statistics,
no fake testimonials. Buttons are verbs: `copy`, `download png`, `swap`,
`clear`. Never `Click here` or `Submit`.

## 5. CSS you may use

All of these exist in `s.css`. **Do not invent new class names** unless the
markup genuinely has no equivalent — and if you do, scope the style in a
`<style>` block in your own file, still using tokens.

**Layout** — `.stack` (column, 1rem gap) · `.stack-2` · `.stack-6` ·
`.row` (wrapping flex row, centre-aligned) · `.row--between` · `.row--end` ·
`.row__spacer` · `.grid2` · `.grid3` (both are one column below 640px) ·
`.section` · `.section--ruled` · `.sep` · `.mt-2` `.mt-3` `.mt-4` `.mt-6` · `.w-full`

**Type** — `.h1` · `.display` · `.lede` · `.lbl` (field label, mono, dim) ·
`.hint` (small dim note) · `.err` (alert-coloured, hidden when empty) ·
`.mono` · `.dim` · `.num` (tabular figures) · `.kbd` · `.vh` (visually hidden)

**Form** — `.field` on every `input`, `textarea`, `select`, `input[type=file]` ·
`input[type=range]` is already styled bare · `.seg` segmented radio control ·
`.check` checkbox row

**Action** — `.btn` (inverted block) · `.btn.-ghost` (hairline outline) ·
`.btn.-sm` · `.btn.-block` · `.tbtn` (bare text button, for row-level affordances)

**Output** — `.out` (mono block, preserves whitespace) · `.out--scroll`
(max-height + scroll) · `.out-head` (label row above an output) ·
`.res` / `.res__k` / `.res__v` (label · value · copy row — the workhorse) ·
`.kv` / `dt` / `dd` (definition readout) · `.figure` (frame for canvas/svg/img) ·
`.reveal` (140ms fade-in; add on newly-computed output, never on page load)

Segmented control markup — the radio must live **inside** its label:

```html
<div class="seg" role="radiogroup" aria-label="format">
  <label><input type="radio" name="fmt" value="png" checked><span>png</span></label>
  <label><input type="radio" name="fmt" value="svg"><span>svg</span></label>
</div>
```

## 6. JS you may use — the `E` global

```
E.tool(fn)                   your whole script; runs after `deps` have loaded
E.qs(sel[, root])            querySelector
E.qsa(sel[, root])           querySelectorAll → real array
E.on(el, ev, fn[, opts])     addEventListener, null-safe
E.el(tag, props, children)   element factory. props: class, text, href, id,
                             type, data-*, aria-*, role, or any DOM property
E.esc(str)                   HTML-escape
E.debounce(fn, ms)           trailing debounce, default 120ms
E.copy(text[, btn])          clipboard write; swaps btn label to "copied"
E.flash(btn, label[, ms])    temporarily swap a button's label
E.download(data, name[,mime])data may be a string or a Blob
E.fail(el, msg)              write msg into an .err element; "" clears it
E.bytes(n)                   1536 → "1.5 KB"
E.rand(n)                    n crypto-random bytes as Uint8Array
E.param(k)                   ?k=… from the query string, or null
E.b64url.enc / .dec          URL-safe base64 of a string, both directions
E.fill(template, values)     "{count} tools" + {count: 3} → "3 tools"
E.base                       prefix that reaches a published root file
E.home                       the index's address from this page
E.toolHref(slug)             another tool's address from this page
E.theme.toggle()             already wired to [data-theme-toggle]
```

Never hardcode a path to another page or to a root file: `file://` and the web
address them differently, which is what `E.base`, `E.home` and `E.toolHref`
exist for.

Prefer `textContent` over `innerHTML`. If you must build markup as a string,
run every interpolated value through `E.esc`. Treat all user input as hostile.

## 7. States

Every interactive element ships all eight: default, hover, `:focus-visible`,
`:active`, disabled, loading, error, success. `.btn` already covers hover /
active / disabled / `[data-state="loading"]` / `[data-state="error"]`; you are
responsible for *setting* those states and for success (a label swap).

Never animate the focus ring. Never remove an outline without replacing it.

## 8. Mobile & a11y

Must render with no horizontal scroll at **320 / 375 / 414 / 768 px**.

- Grid tracks that hold text or images use `minmax(0, 1fr)`, never bare `1fr`.
- Clickable text never wraps to two lines (`.btn` already sets `white-space: nowrap`).
- Every `input`/`textarea`/`select` has a `<label class="lbl" for="…">` or an
  `aria-label`. Every icon-only control has an `aria-label`.
- Live-updating results that matter announce themselves: put `aria-live="polite"`
  on the container that changes.
- Font size for text inputs is at least 16px so iOS does not zoom on focus.
  `.field` already uses `--text-input`; do not shrink it.
- Respect `prefers-reduced-motion` — `s.css` already neutralises transitions;
  don't add JS-driven motion that ignores it.

## 9. Definition of done

- [ ] The page contains a `<main>`, one `E.tool(...)` script, and nothing else:
      no header, no footer, no `<title>`, no `<script src>` of its own.
- [ ] Its row in `tools.js` carries the name, lede, meta, aliases, any `deps`
      and, for a network tool, the footer `note`.
- [ ] `npm run check` passes. It catches a page that writes its own header,
      footer, `<title>` or description, a `deps` script the page also loads
      itself, and a registry row with no page; the rest of the two items
      above is for review.
- [ ] Opens from `file://` and from a static server with no console errors.
- [ ] Produces a correct result for a normal input, an empty input, a huge input,
      and a deliberately malformed input.
- [ ] Every result can be copied or downloaded.
- [ ] Keyboard-only operation works end to end; focus is always visible.
- [ ] No horizontal scroll at 320px.
- [ ] Light and dark both look deliberate.
- [ ] No raw colour, no radius, no shadow, no emoji, no invented numbers.
