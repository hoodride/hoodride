defmodule HoodrideWeb.DefaultPhotoTest do
  @moduledoc """
  Someone without a photo (or whose photo won't load) shows their first
  initial on a colour of their own, or a grey silhouette when the name has
  no letter (avatar.js; owner, 2026-11-01) — as Google does. Never a 🙂.
  """
  use ExUnit.Case, async: true

  @static Path.expand("../../priv/static", __DIR__)
  @app File.read!(Path.join(@static, "app.js"))

  test "avatar.js is served, cached offline, and loaded before app.js" do
    assert "avatar.js" in HoodrideWeb.static_paths()
    assert File.read!(Path.join(@static, "sw.js")) =~ ~s("avatar.js")
    html = File.read!(Path.join(@static, "index.html"))
    {a, _} = :binary.match(html, ~s(src="avatar.js"))
    {app, _} = :binary.match(html, ~s(src="app.js"))
    assert a < app
  end

  test "no smiley stands in for a photo anywhere" do
    refute @app =~ "makeAvatar("
    refute @app =~ "\u{1F642}"
  end

  test "every photo without one, and every photo that fails, uses the person's name" do
    for line <- [
          ~s[$("peer-photo").src = peer.photo || HoodAvatar.url(peer.name);],
          ~s[$("chat-photo").src = state.chatPeer.photo || HoodAvatar.url(state.chatPeer.name);],
          ~s[return (state.realUser && state.realUser.photo) || HoodAvatar.url(myName());]
        ],
        do: assert(@app =~ line, line)

    # a photo that fails falls back to that person's initial: the <img>
    # says whose it is (data-name), set wherever a photo is shown
    assert @app =~ "const fallback = HoodAvatar.url(img.dataset.name);"
    assert @app =~ ~s[$("peer-photo").dataset.name = peer.name || "";]
    assert @app =~ ~s[$("chat-photo").dataset.name = state.chatPeer.name || "";]
  end
end
