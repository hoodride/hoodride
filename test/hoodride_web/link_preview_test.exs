defmodule HoodrideWeb.LinkPreviewTest do
  @moduledoc """
  The link preview (owner, 2026-11-02): what Facebook, iMessage, WhatsApp,
  X, Discord… show when someone shares the address — the Open Graph tags
  (ogp.me) and X's card, on the main page, with a 1200×630 picture
  (priv/static/og.png; its source: assets/og/). Addresses in full (Facebook
  needs them), built from the server's own (PHX_HOST: hoodride.app live);
  the picture by versioned address, so an app that saved an old preview
  fetches the new one.
  """
  use HoodrideWeb.ConnCase, async: true

  @line "Rides from your neighborhood"

  defp page(conn), do: get(conn, "/") |> html_response(200)
  defp base, do: HoodrideWeb.Endpoint.url()

  defp meta(html, attr, key) do
    case Regex.run(~r/<meta #{attr}="#{Regex.escape(key)}" content="([^"]*)"/, html) do
      [_, content] -> content
      nil -> nil
    end
  end

  test "the words: the name and the sign-in screen's line", %{conn: conn} do
    html = page(conn)
    assert meta(html, "name", "description") == @line
    assert meta(html, "property", "og:title") == "Hood Ride"
    assert meta(html, "property", "og:description") == @line
    assert meta(html, "property", "og:site_name") == "Hood Ride"
    assert meta(html, "property", "og:type") == "website"
    # the same line as the sign-in screen
    assert File.read!("priv/static/index.html") =~ ~s(<p class="tagline">#{@line}</p>)
  end

  test "the address in full, the front page with its slash", %{conn: conn} do
    assert meta(page(conn), "property", "og:url") == base() <> "/"
  end

  test "the picture: a full, versioned address, its size and words; X's large card",
       %{conn: conn} do
    html = page(conn)
    v = HoodrideWeb.StaticVersions.of("og.png")
    assert is_binary(v), "og.png must be an app file (HoodrideWeb.static_paths)"
    assert meta(html, "property", "og:image") == base() <> "/og.png?vsn=" <> v
    assert meta(html, "property", "og:image:width") == "1200"
    assert meta(html, "property", "og:image:height") == "630"
    assert meta(html, "property", "og:image:alt") == "Hood Ride: " <> @line
    assert meta(html, "name", "twitter:card") == "summary_large_image"
  end

  test "that address serves a real 1200×630 PNG", %{conn: conn} do
    "http" <> _ = url = meta(page(conn), "property", "og:image")
    %URI{path: path, query: query} = URI.parse(url)
    conn = get(build_conn(), path <> "?" <> query)
    assert conn.status == 200
    assert <<0x89, "PNG", _::binary-size(12), w::32, h::32, _::binary>> = conn.resp_body
    assert {w, h} == {1200, 630}
  end

  test "only the main page: not the privacy policy, the terms or the not-found page",
       %{conn: conn} do
    for path <- ~w(/privacy /terms /a-typo) do
      refute get(build_conn(), path).resp_body =~ "og:image", path
    end

    _ = conn
  end
end
