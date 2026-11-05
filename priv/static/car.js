// "Your car" — shared by the browser (HoodCar) and test_js/car.test.mjs.
// ARCHITECTURE.md "Your car".
//
// What a rider looks for on the street: color, make, model ("check that
// the make and color match the app"). No plate (owner's choice). The
// SERVER decides (Hoodride.Accounts.User car_changeset); these rules are the
// same, so the form can say what's wrong without a round trip.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HoodCar = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // the words in the reader's language (i18n.js): HoodI18n in the page,
  // the file itself in the Node tests
  const I18n = typeof HoodI18n !== "undefined" ? HoodI18n : require("./i18n.js");
  const { tc } = I18n;
  // the server's list, in its order (a test keeps the two the same): the
  // most common US car colors first (iSeeCars 2025)
  const COLORS = ["White", "Black", "Gray", "Silver", "Blue", "Red", "Green", "Brown", "Beige", "Yellow", "Orange", "Gold", "Purple", "Other"];
  // each color as the reader's language names it (the value kept and sent
  // is the English one above — the server's)
  const COLOR_NAMES = {
    White: () => tc("car color", "White"),
    Black: () => tc("car color", "Black"),
    Gray: () => tc("car color", "Gray"),
    Silver: () => tc("car color", "Silver"),
    Blue: () => tc("car color", "Blue"),
    Red: () => tc("car color", "Red"),
    Green: () => tc("car color", "Green"),
    Brown: () => tc("car color", "Brown"),
    Beige: () => tc("car color", "Beige"),
    Yellow: () => tc("car color", "Yellow"),
    Orange: () => tc("car color", "Orange"),
    Gold: () => tc("car color", "Gold"),
    Purple: () => tc("car color", "Purple"),
    Other: () => tc("car color", "Other"),
  };
  function colorName(color) {
    return COLOR_NAMES[color] ? COLOR_NAMES[color]() : color;
  }

  // suggested while typing (the browser's own list — any make can be typed:
  // make/model databases go stale, and this needs no outside service)
  const MAKES = [
    "Acura", "Audi", "BMW", "Buick", "Cadillac", "Chevrolet", "Chrysler", "Dodge", "Fiat", "Ford",
    "Genesis", "GMC", "Honda", "Hyundai", "Infiniti", "Jaguar", "Jeep", "Kia", "Land Rover", "Lexus",
    "Lincoln", "Lucid", "Mazda", "Mercedes-Benz", "Mini", "Mitsubishi", "Nissan", "Polestar", "Porsche",
    "Ram", "Rivian", "Subaru", "Tesla", "Toyota", "Volkswagen", "Volvo",
  ];

  const MAX = 24;
  // control, format (zero-width, right-to-left override), private-use and
  // unassigned characters: Unicode category C, as the server
  const HIDDEN = /\p{C}/u;

  // ordinary spaces trimmed and squeezed (a tab or newline stays — and is
  // refused below), as the server
  function tidyText(s) {
    return typeof s === "string" ? s.replace(/^ +| +$/g, "").replace(/ {2,}/g, " ") : s;
  }

  function tidy(car) {
    return { color: car.color, make: tidyText(car.make), model: tidyText(car.model) };
  }

  // characters as people see them (graphemes, as the server counts)
  function length(s) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) return [...new Intl.Segmenter().segment(s)].length;
    return [...s.normalize("NFC")].length;
  }

  function badText(s) {
    return typeof s !== "string" || s === "" || length(s) > MAX || HIDDEN.test(s);
  }

  // the wrong fields: [] | some of ["color", "make", "model"]
  function problems(car) {
    const c = tidy(car || {});
    const out = [];
    if (!COLORS.includes(c.color)) out.push("color");
    if (badText(c.make)) out.push("make");
    if (badText(c.model)) out.push("model");
    return out;
  }

  // the makes to suggest under the Make box while typing: names starting
  // with it first, then those with a later word starting with it ("benz" →
  // Mercedes-Benz, "ro" → Land Rover); at most 6 (a short list, no
  // scrolling); none when nothing is typed or it's already a full make.
  // Our own list, not the browser's <datalist>: Chrome drew that popup
  // outside the page, far to the left of the box.
  const SUGGEST_MAX = 6;
  // (`makes`: the list to search — tests pass their own)
  function suggest(text, makes = MAKES) {
    const query = typeof text === "string" ? text.trim().toLowerCase() : "";
    if (!query || makes.some((m) => m.toLowerCase() === query)) return [];
    const starts = makes.filter((m) => m.toLowerCase().startsWith(query));
    // (a first word matching is already in `starts`)
    const later = makes.filter((m) => !starts.includes(m) && m.toLowerCase().split(/[\s-]+/).some((w) => w.startsWith(query)));
    return starts.concat(later).slice(0, SUGGEST_MAX);
  }

  // " · Gray Honda Civic" after a name or a line — or "" (none set)
  function inLine(label) {
    return label ? ` · ${label}` : "";
  }

  return { COLORS, colorName, MAKES, MAX, tidy, problems, suggest, inLine };
});
