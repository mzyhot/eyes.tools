# 𓁹𓁹 — tool contract

Read this in full before writing a tool page. Every tool on the site is one
self-contained HTML file in `t/`. There is no build step, no framework, and no
runtime package. Beyond the shared Geist fonts, a page makes no network
requests unless it is a network tool (rule 4).

**Reference implementation: [`t/case.html`](../t/case.html). Skeleton: [`_dev/TEMPLATE.html`](TEMPLATE.html).**
When in doubt, do what `case.html` does.

---

## 1. Hard rules

1. **One file.** `t/<slug>.html`. The only other edits a new tool makes are its
   registration: one row in `tools.js` and the regenerated `_redirects` and
   `vercel.json` (see the README). Do not change `s.css`, `s.js`, another tool,
   or anything else. If you need something the shared layer doesn't offer,
   implement it locally inside your file.
2. **No CDN runtime dependencies.** No remote scripts, npm runtime, or `import`.
   QR and metadata parsing use vendored browser builds. The Geist stylesheet from
   Google Fonts, already in the skeleton, is the one remote file every page
   loads. Network tools are explicit exceptions: verified randomness contacts
   Cloudflare's drand relay, subdomains calls the same-origin `/api/subdomains`
   proxy, and share uses WebRTC.
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
7. **Wrap all JS** in `(function () { "use strict"; ... })();` at the bottom of
   the file. Declare no globals.

## 2. The page skeleton

Copy `_dev/TEMPLATE.html`, replace `SLUG` with your tool's slug in two places
(`<title>` and `<body data-tool="…">`), and set the `<meta name="description">`.

`s.js` reads `data-tool`, finds the entry in `tools.js`, and fills in the
breadcrumb, the `<h1>`, the lede, and `document.title` automatically. **Leave
`[data-crumb]`, `[data-title]` and `[data-lede]` empty** — do not hardcode text
into them.

Everything you write goes inside `<main class="stack-6">` and the `<script>`
block at the bottom. Do not touch the header or footer markup.

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
  `.res__v:empty` and `.out:empty` already render an em dash.
- **Deep-link the input where it's cheap.** `E.param("t")` reads `?t=…`; prefill
  from it if present. Never put user data in the URL automatically.
- **Silent success.** No toasts. Confirm by swapping a button label (`E.flash`),
  which `E.copy` already does.
- **Errors are quiet and specific.** Write the message into an `.err` element:
  `unexpected } at line 4`, not `Something went wrong!`.

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
E.theme.toggle()             already wired to [data-theme-toggle]
```

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

- [ ] Opens from `file://` and from a static server with no console errors.
- [ ] Produces a correct result for a normal input, an empty input, a huge input,
      and a deliberately malformed input.
- [ ] Every result can be copied or downloaded.
- [ ] Keyboard-only operation works end to end; focus is always visible.
- [ ] No horizontal scroll at 320px.
- [ ] Light and dark both look deliberate.
- [ ] No raw colour, no radius, no shadow, no emoji, no invented numbers.
