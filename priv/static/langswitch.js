// The language switch (owner, 2026-11-05) — shared by the browser
// (HoodLang) and test_js/langswitch.test.mjs.
//
// Each language is listed in its OWN words ("Español", "日本語",
// "العربية") — the browser's own names (Intl.DisplayNames, Unicode CLDR:
// what phones show), so a person finds theirs whatever language the page
// is in now. A pick is kept in a cookie the server reads
// (HoodrideWeb.Lang) — only once someone picks; otherwise the phone's
// language decides, nothing stored (the privacy policy lists it).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodLang = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const COOKIE = "hoodride_lang";

  // how these languages name themselves in language menus (CLDR alone
  // gives "Indonesia", "Melayu")
  const OWN = { id: "Bahasa Indonesia", ms: "Bahasa Melayu" };

  // a language's own name, capitalized as it writes it
  function name(tag) {
    if (OWN[tag]) return OWN[tag];
    try {
      const n = new Intl.DisplayNames([tag], { type: "language" }).of(tag);
      if (n && n !== tag) return n.charAt(0).toLocaleUpperCase(tag) + n.slice(1);
    } catch (_) {}
    return tag;
  }

  // the list as a person scans it: by own name, alphabetical in a
  // language-neutral order (Latin, then other scripts)
  function sorted(tags) {
    const c = new Intl.Collator("und");
    return tags.map((tag) => ({ tag, name: name(tag) })).sort((a, b) => c.compare(a.name, b.name));
  }

  // the cookie for a pick: a year, the whole site, sent on navigations only
  // (Lax), over https only on a secure page
  function cookie(tag, secure) {
    return `${COOKIE}=${encodeURIComponent(tag)}; path=/; max-age=31536000; SameSite=Lax` + (secure ? "; Secure" : "");
  }

  return { COOKIE, name, sorted, cookie };
});
