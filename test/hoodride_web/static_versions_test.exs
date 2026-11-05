defmodule HoodrideWeb.StaticVersionsTest do
  @moduledoc """
  Versioned file addresses (MDN "HTTP caching", web.dev "HTTP cache" — found
  on deploy day, 2026-10-28: behind Cloudflare a plain "public" became 4
  hours, so a new page could run old scripts):

    * the page and the offline cache ask for `app.js?vsn=<its fingerprint>`
      — new contents, new address, never an old copy
    * a versioned address is kept a year (`immutable`): phones load each
      version once
    * everything unversioned (sw.js, the manifest, a typed-in /app.js) is
      `no-cache`: kept, but checked first (a cheap 304)
    * a vsn that isn't the file's CURRENT one (an old page after a deploy)
      is answered as unversioned — never cached a year under the wrong name
  """
  use HoodrideWeb.ConnCase, async: false

  alias HoodrideWeb.StaticVersions

  @year "public, max-age=31536000, immutable"

  defp page(conn), do: conn |> get("/") |> html_response(200)

  defp worker_assets(conn) do
    js = conn |> get("/sw.js") |> response(200)
    [_, list] = Regex.run(~r/const ASSETS = \[(.*?)\];/s, js)
    Regex.scan(~r/"([^"]+)"/, list, capture: :all_but_first) |> List.flatten()
  end

  describe "the fingerprint" do
    test "is the file's contents: same contents, same vsn; changed, different" do
      dir = Path.join(System.tmp_dir!(), "vsn-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      on_exit(fn -> File.rm_rf!(dir) end)

      File.write!(Path.join(dir, "a.js"), "one")
      File.write!(Path.join(dir, "b.js"), "one")
      v = StaticVersions.compute(dir, ["a.js", "b.js", "missing.js"])
      assert v["a.js"] == v["b.js"]
      assert v["a.js"] =~ ~r/\A[0-9a-f]{12}\z/
      refute Map.has_key?(v, "missing.js")

      File.write!(Path.join(dir, "a.js"), "two")
      assert StaticVersions.compute(dir, ["a.js"])["a.js"] != v["a.js"]
    end

    # (the not-found page names its files from the root — 2026-11-04)
    test "stamped by name, as written or from the root; anything else untouched" do
      v = %{"a.js" => "abc123"}

      assert StaticVersions.stamp(
               ~s(<script src="a.js"></script><script src="/a.js"></script>),
               v
             ) ==
               ~s(<script src="a.js?vsn=abc123"></script><script src="/a.js?vsn=abc123"></script>)

      for kept <- [~s("b.js"), ~s("/x/a.js"), ~s("https://a.js"), ~s("a.js?vsn=old")] do
        assert StaticVersions.stamp(kept, v) == kept
      end
    end
  end

  describe "the page" do
    test "asks for every app file by its versioned address", %{conn: conn} do
      html = page(conn)
      versions = StaticVersions.current()

      refs =
        Regex.scan(~r/(?:src|href)="([^"]+)"/, html, capture: :all_but_first)
        |> List.flatten()
        |> Enum.reject(&String.contains?(&1, ":"))

      assert "app.js?vsn=#{versions["app.js"]}" in refs
      assert "styles.css?vsn=#{versions["styles.css"]}" in refs

      for ref <- refs do
        [name | _] = String.split(ref, "?")
        if Map.has_key?(versions, name), do: assert(ref == "#{name}?vsn=#{versions[name]}")
      end
    end
  end

  describe "the offline cache" do
    test "stores exactly the page's versioned addresses (offline, they must match)", %{
      conn: conn
    } do
      versions = StaticVersions.current()
      assets = worker_assets(conn)

      # (not "./": the home page can be a redirect to the visitor's language —
      # a saved redirect can't be shown offline; sw.js keeps the home opened)
      refute "./" in assets
      assert "index.html" in assets
      assert "app.js?vsn=#{versions["app.js"]}" in assets
      assert "maplibre-gl.js?vsn=#{versions["maplibre-gl.js"]}" in assets

      for a <- assets,
          a not in ["./", "index.html"],
          do: assert(a =~ ~r/\?vsn=[0-9a-f]{12}\z/, "unversioned in the offline cache: #{a}")

      page_refs =
        Regex.scan(~r/(?:src|href)="([^"]+\?vsn=[^"]+)"/, page(conn), capture: :all_but_first)

      for [ref] <- page_refs,
          not String.starts_with?(ref, "favicon"),
          do: assert(ref in assets, "the page loads #{ref}, the offline cache lacks it")
    end
  end

  describe "how long a file is kept" do
    test "the current vsn: a year, immutable", %{conn: conn} do
      conn = get(conn, "/app.js?vsn=#{StaticVersions.current()["app.js"]}")
      assert conn.status == 200
      assert get_resp_header(conn, "cache-control") == [@year]
    end

    test "no vsn: kept but checked first (no-cache, with an etag)", %{conn: conn} do
      conn = get(conn, "/app.js")
      assert conn.status == 200
      assert get_resp_header(conn, "cache-control") == ["no-cache"]
      assert [_etag] = get_resp_header(conn, "etag")
    end

    test "an old vsn: answered, but never kept a year under that name", %{conn: conn} do
      conn = get(conn, "/app.js?vsn=000000000000")
      assert conn.status == 200
      assert get_resp_header(conn, "cache-control") == ["no-cache"]
    end

    test "the service worker and the page are always checked", %{conn: conn} do
      assert get_resp_header(get(conn, "/sw.js"), "cache-control") == ["no-cache"]
      [cc] = get_resp_header(get(build_conn(), "/"), "cache-control")
      assert cc =~ "max-age=0" or cc =~ "no-cache"
    end
  end
end
