/* 𓁹𓁹: the site configuration.
 *
 * Everything the shared chrome says or does, in one object. Change a value
 * here and every page follows: the wordmark, the tab title, the footer notes,
 * the keyboard shortcuts, the storage keys, the not-found page.
 *
 * Nothing in this file touches the DOM. `s.js` reads it and builds the header,
 * the title block and the footer from it; `theme.js` reads the storage key
 * before the first paint; `index.js` reads the index copy; the Node server
 * reads it to write each page's link preview. A page never repeats any of it.
 *
 * What each tool says about itself (its name, lede, search aliases, extra
 * scripts and network note) lives in `tools.js`, one row per tool.
 *
 * Loaded in the head, before `theme.js`, so the theme can read its key.
 */
window.SITE = {
  /* The wordmark is the literal Unicode text, not an image: U+13079 twice. */
  wordmark: "𓁹𓁹",
  /* Appended to every tool's name in `document.title`. */
  titleSuffix: " · 𓁹𓁹",
  /* The index's own title and meta description. */
  title: "𓁹𓁹",
  description: "Small, local-first tools for text, code, images, and everyday tasks. Open a tool and get a result. Network tools explain their connections.",
  /* Address-bar colour. Matches `--color-paper` of the theme in force. */
  themeColor: { dark: "#070707", light: "#fbfbfb" },
  icon: "favicon.svg",

  /* What a link preview shows, in a chat app or a search result, where the
     page's scripts never run: the site's name in plain letters, since the
     wordmark's hieroglyphs do not render everywhere, its public address, and
     a picture published at the site root. A copy served from somewhere else
     changes `url` to its own address. */
  name: "eyes.tools",
  url: "https://eyes.tools",
  preview: { image: "preview.png", width: 1200, height: 630, alt: "two outlined eyes above the words eyes.tools" },

  /* Labels the chrome reuses on every page. */
  labels: {
    home: "← all tools",
    homeAria: "𓁹𓁹, all tools",
    theme: "theme",
    themeSwitch: "Switch to {next} mode",       /* {next} is "dark" or "light" */
    themeCurrent: ". Current theme: {current}.",
    skipToTool: "skip to tool",
    skipToTools: "skip to tools"
  },

  /* Footer notes. A tool with a `note` in the registry replaces `local`. */
  footer: {
    local: "runs in your browser · nothing is uploaded",
    index: "local-first · network tools disclose their connections"
  },

  /* The index page, built by `index.js`. */
  index: {
    heading: "𓁹𓁹, tools",
    filterLabel: "filter tools",
    filterPlaceholder: "filter",
    clearLabel: "clear",
    clearAria: "clear search",
    keyboardHint: [["/", "to filter"], ["↑↓", "to move"], ["↵", "to open"]],
    help: "Type to filter. Use the up and down arrow keys to select a tool, then enter to open.",
    emptyText: "nothing by that name.",
    emptyAction: "clear filter",
    noscript: "These tools need JavaScript to run.",
    /* {count} tools, or {count} of {total} while filtering. */
    count: "{count} tools",
    countFiltered: "{count} of {total}"
  },

  /* The page the server returns for an address that has nothing at it. */
  notFound: {
    title: "nothing here",
    lede: "the eyes looked. there is no page at this address.",
    action: "go to the tools"
  },

  /* Keyboard behaviour, shared by the index and every tool page. */
  shortcuts: {
    filterKey: "/",        /* focuses the index filter */
    escapeToIndex: true    /* Esc leaves a field, then leaves the tool */
  },

  /* The site's public address, for a copy of the pages served from somewhere
     else, such as the desktop app. Links the pages make for other people
     (dump's text links, share's room links) point here, and share's rooms and
     connection setup go through the service here; file contents still travel
     device to device. Empty means wherever the page itself is. */
  publicOrigin: "",

  /* Browser storage keys. Tools add their own; these belong to the chrome. */
  storage: {
    theme: "eyes.theme",
    themeDefault: "dark"
  }
};
