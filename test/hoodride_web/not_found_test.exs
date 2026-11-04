defmodule HoodrideWeb.NotFoundTest do
  @moduledoc """
  Addresses that don't exist (owner, 2026-10-30): a real 404 — Google's
  guidance (it never indexes a 4xx; redirecting to the home page is a "soft
  404"), and scanners stop reporting "/.env found". Since 2026-11-02 (owner)
  the page says so — "Page not found", a button home — instead of the app
  silently showing the map (NN/g, MDN: a custom 404 page that tells people
  why they're seeing it). The address stays as typed. Real addresses keep
  their 200.
  """
  use HoodrideWeb.ConnCase, async: true

  @paths ~w(/anything /some/deep/path /.env /wp-login.php /app.js.map /index.htm)

  test "an address that doesn't exist: 404, and a page that says so", %{conn: conn} do
    for path <- @paths do
      conn = get(build_conn(), path)
      assert conn.status == 404, "#{path}: #{conn.status}"
      body = conn.resp_body
      assert body =~ "<title>Page not found — Hood Ride</title>", path
      assert body =~ "<h1>Page not found</h1>", path
      assert body =~ "This page doesn't exist."
      assert body =~ ~s(<a class="home" href="/">Go to Hood Ride</a>), "#{path}: a way home"
    end

    _ = conn
  end

  test "the not-found page isn't the app: no map, no app code, no connection", %{conn: conn} do
    body = get(build_conn(), "/a-typo").resp_body
    refute body =~ ~s(id="screen-map")
    refute body =~ "app.js"
    refute body =~ ~s(name="hoodride-build")
    _ = conn
  end

  test "its look and the car come by versioned address (the CSP: no inline style)", %{conn: conn} do
    body = get(build_conn(), "/a-typo").resp_body
    assert body =~ ~r{href="privacy\.css\?vsn=[0-9a-f]+"}
    assert body =~ ~r{src="car\.png\?vsn=[0-9a-f]+"}
    refute body =~ "<style"
    _ = conn
  end

  test "the real pages: 200", %{conn: conn} do
    for path <- ~w(/ /index.html /privacy /sw.js) do
      assert get(build_conn(), path).status == 200, path
    end

    _ = conn
  end

  # the offline copy is installed from this list all at once: one 404 among
  # them and the service worker never installs
  test "every file the offline copy downloads answers 200", %{conn: conn} do
    [_, list] = Regex.run(~r/const ASSETS = \[(.*?)\];/s, File.read!("priv/static/sw.js"))

    for [file] <- Regex.scan(~r/"([^"]+)"/, list, capture: :all_but_first) do
      path = if file == "./", do: "/", else: "/" <> file
      assert get(build_conn(), path).status == 200, path
    end

    _ = conn
  end
end
