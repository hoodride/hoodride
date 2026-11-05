// Hood Ride's words in the reader's language (owner, 2026-11-04). Every
// visible message goes through t("…") with its ENGLISH text as the key (as
// gettext does): with no translation loaded — English, or a message not
// translated yet — the English shows, never a blank or a key.
//
// The translations come from gettext's standard .po files
// (priv/gettext/<lang>/LC_MESSAGES/default.po), turned into one small JSON
// catalog per language at build time:
//
//   { "lang": "es",
//     "messages": { "Need a ride": "Necesito un viaje",
//                   "Drive\u0004…": "…",                        (a context)
//                   "{count} car\u0000{count} cars": { "one": "…", "other": "…" } } }
//
// Plurals by the browser's own rules (Intl.PluralRules): a category the
// catalog lacks — Spanish's "many" (exact millions, CLDR) when its .po has
// only two forms — falls back to "other", then to the English.
// Shared by the browser (HoodI18n) and test_js/i18n.test.mjs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodI18n = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // gettext's own separators: context, then message (EOT); singular, then
  // plural (NUL)
  const CTX = "\u0004";
  const PLURAL = "\u0000";

  let lang = "en";
  let messages = {};
  let rules = null;

  function pluralRules(l) {
    try {
      return new Intl.PluralRules(l);
    } catch (_) {
      return new Intl.PluralRules("en");
    }
  }

  // {name} → vars.name; a placeholder with no value stays as written (a
  // visible mistake beats a silent "undefined")
  function fill(text, vars) {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, key) =>
      Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null ? String(vars[key]) : whole
    );
  }

  // a catalog (see above), or null for English
  function load(catalog) {
    if (catalog && typeof catalog.lang === "string" && catalog.messages && typeof catalog.messages === "object") {
      lang = catalog.lang;
      messages = catalog.messages;
    } else {
      lang = "en";
      messages = {};
    }
    rules = pluralRules(lang);
    return lang;
  }

  // a translation, or "" / null — the callers' `||` turns either into
  // the English
  function lookup(key) {
    const found = messages[key];
    return typeof found === "string" ? found : null;
  }

  // t("Need a ride"), t("Hi {name}", { name })
  function t(msgid, vars) {
    return fill(lookup(msgid) || msgid, vars);
  }

  // the same English meaning two things: tc("button", "Drive")
  function tc(context, msgid, vars) {
    return fill(lookup(context + CTX + msgid) || msgid, vars);
  }

  // tn("{count} car", "{count} cars", n) — `count` is filled in for you
  function tn(singular, plural, n, vars) {
    const all = Object.assign({ count: n }, vars || {});
    const forms = messages[singular + PLURAL + plural];
    if (forms && typeof forms === "object") {
      if (!rules) rules = pluralRules(lang);
      const chosen = forms[rules.select(n)] || forms.other;
      if (typeof chosen === "string" && chosen !== "") return fill(chosen, all);
    }
    return fill(n === 1 ? singular : plural, all);
  }

  // ----- the page's own words (index.html): marked, not wrapped -----
  //   <button data-t>Save</button>          data-t="context": tc
  //   <p data-t>By continuing, you agree to our
  //     <a data-t data-t-slot="terms">Terms</a> and <a … data-t-slot="privacy">…</a>.</p>
  //   → one message: "By continuing, you agree to our {terms} and {privacy}."
  //     (the links stay the same elements, wherever the language puts them)
  //   data-t-attr="aria-label title": those attributes' English is a message
  // An element that isn't a slot (an icon, a <select>) may stand before or
  // after the words, never between them. The collector (Hoodride.I18n.Extract
  // scan_html) reads the same marks by the same rules. English changes
  // nothing on the page; a language read at start-up (switching reloads).
  const SPACE = /[ \t\n\r\f]+/g;
  const tidy = (s) => s.replace(SPACE, " ").trim();
  const isWords = (n) => (n.nodeType === 1 ? n.hasAttribute("data-t-slot") : n.nodeType === 3 && tidy(n.nodeValue) !== "");

  // { lead, tail, slots, msgid, ctx }, or null (no words, or something in
  // the way) — read once: the English, before any language replaced it
  function readMarked(el) {
    const kids = Array.from(el.childNodes).filter((n) => n.nodeType === 1 || n.nodeType === 3);
    const first = kids.findIndex(isWords);
    if (first < 0) return null;
    let last = kids.length - 1;
    while (!isWords(kids[last])) last--;
    const slots = {};
    let text = "";
    for (const n of kids.slice(first, last + 1)) {
      if (n.nodeType === 3) text += n.nodeValue;
      else if (n.hasAttribute("data-t-slot")) {
        const name = n.getAttribute("data-t-slot");
        slots[name] = n;
        text += `{${name}}`;
      } else return null;
    }
    return { lead: kids.slice(0, first), tail: kids.slice(last + 1), slots, msgid: tidy(text), ctx: el.getAttribute("data-t") || "" };
  }

  const marked = new WeakMap();
  const markedAttrs = new WeakMap();

  function translatePage(root) {
    if (lang === "en") return;
    root.querySelectorAll("[data-t]").forEach((el) => {
      if (!marked.has(el)) marked.set(el, readMarked(el));
      const m = marked.get(el);
      if (!m) return;
      const text = m.ctx ? tc(m.ctx, m.msgid) : t(m.msgid);
      const doc = el.ownerDocument;
      const words = [];
      text.split(/(\{\w+\})/).forEach((part) => {
        const slot = /^\{(\w+)\}$/.exec(part);
        if (slot && m.slots[slot[1]]) words.push(m.slots[slot[1]]);
        else if (part) words.push(doc.createTextNode(part));
      });
      el.replaceChildren(...m.lead, ...words, ...m.tail);
    });
    root.querySelectorAll("[data-t-attr]").forEach((el) => {
      if (!markedAttrs.has(el)) {
        const english = {};
        el.getAttribute("data-t-attr")
          .split(SPACE)
          .filter(Boolean)
          .forEach((name) => {
            if (el.hasAttribute(name)) english[name] = el.getAttribute(name);
          });
        markedAttrs.set(el, english);
      }
      const english = markedAttrs.get(el);
      Object.keys(english).forEach((name) => el.setAttribute(name, t(english[name])));
    });
  }

  load(null);
  return { load, t, tc, tn, fill, translatePage, lang: () => lang, CTX, PLURAL };
});
