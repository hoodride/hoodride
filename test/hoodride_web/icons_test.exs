defmodule HoodrideWeb.IconsTest do
  @moduledoc """
  The app's icons — ✋ 📍 🧭 💬 — are pictures (Microsoft's Fluent Emoji,
  Color style, MIT; owner, 2026-11-01), not emoji: every phone draws an
  emoji its own way, and an older one may draw a box (🧭 needs Android 9).
  The pictures are served and cached offline, the licence goes with them,
  and the page itself shows no emoji for them.
  """
  use ExUnit.Case, async: true

  @static Path.expand("../../priv/static", __DIR__)
  @icons ~w(hand.svg pin.svg compass.svg chat.svg hand-avatar.svg person.svg)
  @emoji ["✋", "\u{1F4CD}", "\u{1F9ED}", "\u{1F4AC}"]

  test "the pictures: SVG, nothing that runs, nothing fetched from elsewhere" do
    for f <- @icons do
      svg = File.read!(Path.join(@static, f))
      assert svg =~ ~r/^<svg /, f
      refute svg =~ ~r/<script|foreignObject|\son[a-z]+=|href="http/i, f
    end
  end

  test "served, cached offline, loaded before app.js, and the licence with them" do
    sw = File.read!(Path.join(@static, "sw.js"))

    for f <- ["icons.js" | @icons],
        do: assert(f in HoodrideWeb.static_paths() and sw =~ ~s("#{f}"), f)

    license = File.read!(Path.join(@static, "fluent-emoji.LICENSE.txt"))
    assert license =~ "MIT License" and license =~ "Copyright (c) Microsoft Corporation."
    assert "fluent-emoji.LICENSE.txt" in HoodrideWeb.static_paths()

    html = File.read!(Path.join(@static, "index.html"))
    {icons, _} = :binary.match(html, ~s(src="icons.js"))
    {app, _} = :binary.match(html, ~s(src="app.js"))
    assert icons < app
  end

  test "the page shows the pictures, never the emoji" do
    html = File.read!(Path.join(@static, "index.html"))
    for e <- @emoji, do: refute(html =~ e, "emoji #{e} on the page")

    for {id, src} <- [
          {"btn-hand", "hand.svg"},
          {"btn-chat", "chat.svg"},
          {"btn-pin", "pin.svg"},
          {"btn-navigate", "compass.svg"}
        ] do
      assert html =~ ~r/id="#{id}"[^>]*>\s*<img class="emoji-icon" src="#{src}"/, id
    end
  end
end
