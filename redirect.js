/* 𓁹𓁹: compatibility redirects.
 *
 * One file for every page that only exists to forward an old address to a
 * current one. The page says where it goes with data attributes, so adding a
 * redirect is a copy of `t/lines.html` with two values changed:
 *
 *   <script src="../redirect.js" data-to="dump" data-mode="lines"></script>
 *
 * `data-to` is the destination slug and the optional `data-mode` is a query
 * parameter to set on arrival. The original query string and fragment are
 * carried across, and the page keeps a plain link for anyone without script.
 */
(function () {
  "use strict";
  var tag = document.currentScript;
  if (!tag || !tag.dataset.to) return;
  var slug = tag.dataset.to;
  var target = location.protocol === "file:" ? slug + ".html" : "/" + slug;
  var url = new URL(target, location.href);
  url.search = location.search;
  if (tag.dataset.mode) url.searchParams.set("mode", tag.dataset.mode);
  url.hash = location.hash;
  location.replace(url.href);
})();
