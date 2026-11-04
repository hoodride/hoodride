defmodule HoodrideWeb.DrawerFocusTest do
  @moduledoc """
  Where focus lands when the drawer opens (owner, 2026-10-29): on the name
  at the top, not the ✕. The W3C dialog pattern allows a static element at
  the top with tabindex="-1" (the title) as the first focus. Focus moved by
  code onto a button can draw a focus ring after a tap — `:focus-visible`
  leaves the "nothing focused before" case to the browser, and Safari draws
  it (a ring on ✕ after signing back in). The name is the dialog's label
  (aria-labelledby), so a screen reader still starts at the top, and ✕ is
  one Tab away — with its ring when tabbed to.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @css File.read!("priv/static/styles.css")

  test "opening the drawer focuses the name, not the ✕" do
    [open] = Regex.run(~r/function openSettings\(.*?\n}\n/s, @app)
    assert open =~ ~s[$("settings-name").focus();]
    refute open =~ ~s[$("settings-close").focus();]
  end

  test "the name is focusable by code only, and is the drawer's label" do
    assert @html =~ ~s(<strong id="settings-name" tabindex="-1"></strong>)
    assert @html =~ ~s(aria-labelledby="settings-name")
  end

  # not a control (nothing to operate), so no ring on it; the ✕ and the other
  # buttons keep theirs
  test "no ring on the focused name; nothing else's ring is touched" do
    assert @css =~ ~s(#settings-name:focus { outline: none; })
    refute @css =~ ~r/\.drawer-close:focus[^{]*\{[^}]*outline:\s*none/
  end

  # the car sheet already starts on its title (a <select> would pop its
  # picker on iPhone), and already had its no-ring rule
  test "the car sheet's title: focused on open, no ring" do
    assert @html =~ ~s(<h2 id="car-title" tabindex="-1">)
    [open] = Regex.run(~r/function openCarSheet\(.*?\n}\n/s, @app)
    assert open =~ ~s[$("car-title").focus();]
    assert @css =~ ~s(.car-sheet h2:focus { outline: none; })
  end

  # W3C dialog pattern: closing returns focus to what opened it. After a tap,
  # without a ring (focusVisible: false — Safari 18.4+, Firefox 104+, Chrome
  # 145+; older browsers ignore it); after a key (Escape, or Enter/Space on
  # a button: a click with detail 0), with one
  # preventScroll: focusing something off-screen scrolls its container into
  # view — the map's box scrolled ~2,700 × 2,200 px for an off-screen marker
  # (Chrome check, 2026-10-29); never scroll for a focus move
  test "returnFocus: no ring after a tap, the ring after a key; never scrolls" do
    [f] = Regex.run(~r/function returnFocus\(.*?\n}\n/s, @app)

    assert f =~
             ~s[el.focus(byKeyboard(e) ? { preventScroll: true } : { focusVisible: false, preventScroll: true });]

    [k] = Regex.run(~r/function byKeyboard\(.*?\n}\n/s, @app)
    assert k =~ ~s[e instanceof KeyboardEvent]
    assert k =~ ~s[e.type === "click" && e.detail === 0]
  end

  test "closing the drawer returns focus to the photo button, told how it closed" do
    [close] = Regex.run(~r/function closeSettings\(.*?\n}\n/s, @app)
    assert close =~ ~s[returnFocus($("btn-account"), e);]
    refute close =~ ~s[$("btn-account").focus();]
    assert @app =~ ~s[if (e.key === "Escape" && settingsOpen()) closeSettings(e);]
  end

  # it used to drop focus on nothing (Chrome check, 2026-10-29)
  test "closing the car sheet returns focus to what opened it" do
    [open] = Regex.run(~r/function openCarSheet\(.*?\n}\n/s, @app)
    assert open =~ ~s[carSheetOpener = goOnline ? $("btn-mode") : $("btn-account");]
    [close] = Regex.run(~r/function closeCarSheet\(.*?\n}\n/s, @app)
    assert close =~ "returnFocus(carSheetOpener, e);"
    assert @app =~ ~s[if (e.key === "Escape" && carSheetOpen()) closeCarSheet(e);]
  end
end
