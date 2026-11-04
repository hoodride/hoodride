defmodule HoodrideWeb.BrandTest do
  @moduledoc """
  The app is Hood Ride (owner, 2026-10-31: "cab" says taxi — UberCab dropped
  it for the same reason). Nothing in the repository may still carry the old
  name — not a page, not a module, not a file name — so it can be open
  sourced as it stands. (The old name is spelled in pieces here, so this
  file doesn't match itself.)
  """
  use ExUnit.Case, async: true

  @old ["hood" <> "cab", "hood " <> "cab", "hood-" <> "cab", "hood_" <> "cab"]
  @taxi "\u{1F695}"

  # every file git tracks, from the repository root (= the app's folder)
  defp tracked do
    {out, 0} = System.cmd("git", ["ls-files"], cd: Path.expand("../..", __DIR__))
    root = Path.expand("../..", __DIR__)
    out |> String.split("\n", trim: true) |> Enum.map(&{&1, Path.join(root, &1)})
  end

  test "no file name carries the old name" do
    bad = for {rel, _} <- tracked(), String.contains?(String.downcase(rel), @old), do: rel
    assert bad == []
  end

  test "no file's text carries the old name, and no taxi emoji" do
    bad =
      for {rel, path} <- tracked(),
          text = File.read!(path),
          String.valid?(text),
          lower = String.downcase(text),
          String.contains?(lower, @old) or String.contains?(text, @taxi),
          do: rel

    assert bad == []
  end

  # taxi yellow back, with a yellow car to match (owner, 2026-11-01: tried
  # green side by side, preferred the yellow) — dark text on it, 11.6:1
  test "the colour is the car's yellow everywhere; none of the trial greens left" do
    root = Path.expand("../..", __DIR__)
    ours = Path.wildcard(Path.join(root, "priv/static/*.{css,js,html,json}"))
    ours = Enum.reject(ours, &String.contains?(&1, ["maplibre", "h3-js", "phoenix.min"]))
    for f <- ours, do: refute(File.read!(f) =~ ~r/#38dd2c|#22c55e|#14f004/i, Path.basename(f))
    assert File.read!(Path.join(root, "priv/static/styles.css")) =~ "--accent: #ffc107;"
    assert File.read!(Path.join(root, "priv/static/privacy.css")) =~ "--accent: #ffc107;"
  end

  # the car is the owner's image (AI-made, 2026-10-31), not the emoji — an
  # emoji looks different on every phone (and is red)
  defp png_size(path) do
    <<137, "PNG", _::binary-size(12), w::32, h::32, _::binary>> = File.read!(path)
    {w, h}
  end

  defp ico_sizes(path) do
    <<0::16-little, 1::16-little, n::16-little, rest::binary>> = File.read!(path)
    for <<w, h, _::binary-size(14) <- binary_part(rest, 0, n * 16)>>, do: {w, h}
  end

  test "the car image, the home-screen icons and the favicon, in their sizes" do
    s = Path.expand("../../priv/static", __DIR__)
    assert {384, _} = png_size(Path.join(s, "car.png"))
    assert png_size(Path.join(s, "car-avatar.png")) == {96, 96}
    for n <- [180, 192, 512], do: assert(png_size(Path.join(s, "icon-#{n}.png")) == {n, n})
    assert Enum.sort(ico_sizes(Path.join(s, "favicon.ico"))) == [{16, 16}, {32, 32}, {48, 48}]
    refute File.exists?(Path.join(s, "icon.svg"))

    index = File.read!(Path.join(s, "index.html"))
    assert index =~ ~s(<link rel="icon" href="favicon.ico" sizes="16x16 32x32 48x48" />)
    assert index =~ ~s(<link rel="apple-touch-icon" href="icon-180.png" />)

    icons = Jason.decode!(File.read!(Path.join(s, "manifest.json")))["icons"]

    assert Enum.map(icons, &{&1["src"], &1["sizes"], &1["type"]}) ==
             [{"icon-192.png", "192x192", "image/png"}, {"icon-512.png", "512x512", "image/png"}]
  end

  test "no car emoji on screen: the page has none; the app only in the demo's chat lines" do
    s = Path.expand("../../priv/static", __DIR__)
    car = <<0x1F697::utf8>>
    refute File.read!(Path.join(s, "index.html")) =~ car

    lines =
      for l <- String.split(File.read!(Path.join(s, "app.js")), "\n"),
          l =~ car,
          do: String.trim(l)

    assert lines == [~s("omw in a sec #{car}",), ~s[receiveMsg(peer, "accepted! omw #{car}");]]
  end

  test "what people see: the page, the install name" do
    root = Path.expand("../..", __DIR__)
    index = File.read!(Path.join(root, "priv/static/index.html"))
    assert index =~ "<h1>Hood Ride</h1>"
    assert index =~ "<title>Hood Ride</title>"
    assert index =~ ~s(<img class="brand-car" src="car.png" alt="" />)
    manifest = Jason.decode!(File.read!(Path.join(root, "priv/static/manifest.json")))
    assert manifest["name"] =~ "Hood Ride"
  end
end
