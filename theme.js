/* 𓁹𓁹: the theme, before first paint.
 *
 * The one script every page loads in its head, and the only code that runs
 * before the body is parsed. It reads the stored choice and sets `data-theme`
 * on `<html>`, so a light-theme visitor never sees a dark flash.
 *
 * Everything after that (the toggle, the address-bar colour, following a
 * change made in another tab) belongs to `s.js` and runs later. Both read the
 * key from `site.js`, which loads first.
 */
(function () {
  "use strict";
  try {
    var key = (window.SITE && window.SITE.storage && window.SITE.storage.theme) || "eyes.theme";
    var stored = localStorage.getItem(key);
    if (stored === "dark" || stored === "light") document.documentElement.setAttribute("data-theme", stored);
  } catch (e) {}
})();
