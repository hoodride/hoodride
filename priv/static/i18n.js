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

  load(null);
  return { load, t, tc, tn, fill, lang: () => lang, CTX, PLURAL };
});
