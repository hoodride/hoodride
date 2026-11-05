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

  // ----- the search (owner, 2026-11-05: NN/g — a long list wants a filter;
  // Apple and Google: a search field with a hint and a Clear button) -----

  // the other names people type (GOV.UK and DfE: other names help — "maths"
  // finds mathematics): old or everyday names CLDR doesn't give
  const ALSO = {
    "zh-Hans": ["Mandarin", "中文", "普通话"],
    "zh-Hant": ["中文", "國語"],
    fil: ["Tagalog"],
    es: ["Castellano"],
    nb: ["Norwegian", "Norsk"],
    or: ["Oriya"],
    bn: ["Bengali"],
    pa: ["Panjabi"],
    ms: ["Malay"],
    id: ["Indonesian"],
  };

  // as people type it: no capitals, no accents ("espanol" finds Español)
  const plain = (s) =>
    String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

  function namesOf(tag, pageLang) {
    const out = [name(tag), tag].concat(ALSO[tag] || []);
    for (const lang of ["en", pageLang]) {
      try {
        const n = new Intl.DisplayNames([lang], { type: "language" }).of(tag);
        if (n) out.push(n);
      } catch (_) {}
    }
    return out;
  }

  // how well a language answers what's typed: 0 the whole name, 1 a name
  // (or one of its words) starts with it, 2 it's anywhere in a name; null
  // no match. Its own, English, the page's language's, and other names
  function rank(tag, query, pageLang) {
    const q = plain(query);
    if (!q) return 0;
    let best = null;
    for (const n of namesOf(tag, pageLang)) {
      const p = plain(n);
      const r =
        p === q ? 0 : p.startsWith(q) || p.split(/[\s(（)）-]+/).some((w) => w.startsWith(q)) ? 1 : p.includes(q) ? 2 : null;
      if (r !== null && (best === null || r < best)) best = r;
    }
    return best;
  }

  // the list for a search: matches only, the closest first (DfE: an exact
  // match first), then by own name; nothing typed — the whole list
  function search(tags, query, pageLang) {
    const c = new Intl.Collator("und");
    return sorted(tags)
      .map((x) => ({ ...x, rank: rank(x.tag, query, pageLang) }))
      .filter((x) => x.rank !== null)
      .sort((a, b) => a.rank - b.rank || c.compare(a.name, b.name));
  }

  // the cookie for a pick: a year, the whole site, sent on navigations only
  // (Lax), over https only on a secure page
  function cookie(tag, secure) {
    return `${COOKIE}=${encodeURIComponent(tag)}; path=/; max-age=31536000; SameSite=Lax` + (secure ? "; Secure" : "");
  }

  return { COOKIE, name, sorted, search, cookie };
});
