defmodule HoodrideWeb.StaticFilesTest do
  # Plug.Static serves only the files named in HoodrideWeb.static_paths/0: a
  # new script the page loads but the list forgets is a 404 in the app (and
  # the offline cache's install fails outright).
  use HoodrideWeb.ConnCase, async: true

  @static Path.expand("../../priv/static", __DIR__)

  defp page_files do
    html = File.read!(Path.join(@static, "index.html"))

    Regex.scan(~r/(?:src|href)="([^"]+)"/, html, capture: :all_but_first)
    |> List.flatten()
    |> Enum.reject(&String.contains?(&1, ":"))
  end

  defp cached_files do
    sw = File.read!(Path.join(@static, "sw.js"))
    [_, list] = Regex.run(~r/const ASSETS = \[(.*?)\];/s, sw)

    Regex.scan(~r/"([^"]+)"/, list, capture: :all_but_first)
    |> List.flatten()
    |> Enum.reject(&(&1 == "./"))
  end

  test "every file the page loads is served" do
    for file <- page_files(), do: assert(served?(file), "#{file} is not in static_paths")
  end

  test "every file the offline cache stores is served" do
    for file <- cached_files(), do: assert(served?(file), "#{file} is not in static_paths")
  end

  test "the location logic is loaded and cached" do
    assert "locator.js" in page_files()
    assert "locator.js" in cached_files()
  end

  test "a served file really comes back", %{conn: conn} do
    conn = get(conn, "/locator.js")
    assert conn.status == 200
    assert conn.resp_body =~ "HoodLocator"
  end

  # the page and the service worker come stamped from PageController; the
  # privacy policy and the terms are pages of their own there too (/privacy,
  # /terms); /auth/* is sign-in (AuthController) — the "Refresh from
  # Google" link goes there
  @pages ~w(index.html sw.js privacy terms auth)

  defp served?(file) do
    [first | _] = String.split(file, "/", trim: true)
    first in HoodrideWeb.static_paths() or first in @pages
  end
end
