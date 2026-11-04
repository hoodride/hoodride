defmodule HoodrideWeb.BuildTest do
  @moduledoc """
  Update after deploy. A page left open keeps running the old app; the
  server says which BUILD it runs and the app compares it with the build it
  was loaded as (test_js/update.test.mjs has the when-to-reload rules).

  The build is a fingerprint of the app's own files, computed at boot —
  nobody bumps it: change any file, deploy, and it differs; restart with
  nothing changed, and it doesn't (no pointless reloads). The page is
  stamped with it as it's served (so a deploy between loading the files and
  connecting can't go unnoticed), and so is the service worker's cache name
  (no hand-bumped "hoodride-vNN").

  The wire PROTOCOL stays a hand-set number — "old apps can no longer talk
  to this server" is a judgement — but it lives in two places, so a test
  holds them equal.
  """
  use HoodrideWeb.ConnCase, async: false

  # (ConnCase imports ConnTest's connect/2: only what this file needs here)
  import Phoenix.ChannelTest, only: [subscribe_and_join: 3]
  require Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias HoodrideWeb.Build

  @static Path.expand("../../priv/static", __DIR__)

  defp dir_with(files) do
    dir = Path.join(System.tmp_dir!(), "hoodride-build-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    for {name, body} <- files, do: File.write!(Path.join(dir, name), body)
    on_exit(fn -> File.rm_rf!(dir) end)
    dir
  end

  describe "the fingerprint" do
    test "the same files give the same build, whatever order they're listed in" do
      dir = dir_with(%{"a.js" => "one", "b.css" => "two"})
      assert Build.compute(dir, ["a.js", "b.css"]) == Build.compute(dir, ["b.css", "a.js"])
    end

    test "changing one byte of any file gives a new build" do
      before = Build.compute(dir_with(%{"a.js" => "one", "b.css" => "two"}), ["a.js", "b.css"])
      after_ = Build.compute(dir_with(%{"a.js" => "one", "b.css" => "twO"}), ["a.js", "b.css"])
      refute before == after_
    end

    test "a renamed file gives a new build (content alone isn't enough)" do
      a = Build.compute(dir_with(%{"a.js" => "same"}), ["a.js"])
      b = Build.compute(dir_with(%{"b.js" => "same"}), ["b.js"])
      refute a == b
    end

    test "a file that isn't there is skipped, not a crash (static_paths names folders too)" do
      dir = dir_with(%{"a.js" => "one"})
      assert Build.compute(dir, ["a.js", "assets"]) == Build.compute(dir, ["a.js"])
    end

    test "the running build is a short hex string covering the real app files" do
      assert Build.current() =~ ~r/\A[0-9a-f]{12}\z/
      assert Build.current() == Build.compute(@static, Build.files())
      assert "app.js" in Build.files()
      assert "index.html" in Build.files()
      assert "sw.js" in Build.files()
    end
  end

  describe "the page and the service worker carry it" do
    test "the page is stamped with the build", %{conn: conn} do
      html = conn |> get("/") |> html_response(200)
      assert html =~ ~s(<meta name="hoodride-build" content="#{Build.current()}">)
    end

    test "/index.html is the same stamped page, never an unstamped copy", %{conn: conn} do
      html = conn |> get("/index.html") |> html_response(200)
      assert html =~ ~s(<meta name="hoodride-build" content="#{Build.current()}">)
    end

    test "the service worker's cache is named after the build", %{conn: conn} do
      conn = get(conn, "/sw.js")
      assert conn.status == 200
      assert [type] = get_resp_header(conn, "content-type")
      assert type =~ "javascript"
      # the browser must always ask for a fresh copy (it's how it finds updates)
      assert get_resp_header(conn, "cache-control") == ["no-cache"]
      assert conn.resp_body =~ ~s(const CACHE = "hoodride-#{Build.current()}";)
    end
  end

  # PROD: the stamped page and sw.js are prepared ONCE at start-up — the
  # running server serves exactly the version it started with, even if
  # files on disk change under it (a deploy copying files before the
  # restart sent NEW code under the OLD build tag). Dev reads per request,
  # so edits show on a reload.
  describe "prepared at start-up (prod)" do
    setup do
      on_exit(&HoodrideWeb.PageController.forget/0)
    end

    # stands in for the files on disk, so the real ones are never touched
    defp files(page, sw) do
      fn
        "index.html" -> page
        "sw.js" -> sw
      end
    end

    test "once prepared, the page and sw.js come from the prepared copy, not the disk", %{
      conn: conn
    } do
      HoodrideWeb.PageController.prepare(
        files(
          "<html><head></head><body>PREPARED</body></html>",
          ~s(const CACHE = "x";\n// PREPARED-SW)
        )
      )

      html = conn |> get("/") |> html_response(200)
      assert html =~ "PREPARED"
      assert html =~ ~s(<meta name="hoodride-build" content="#{Build.current()}">)

      sw = get(build_conn(), "/sw.js")
      assert sw.resp_body =~ "PREPARED-SW"
      assert sw.resp_body =~ ~s(const CACHE = "hoodride-#{Build.current()}";)
      assert get_resp_header(sw, "cache-control") == ["no-cache"]
    end

    # prod prepares BEFORE the Endpoint starts, and Endpoint.url() raises
    # then: the link preview's full addresses (HoodrideWeb.LinkPreviewTest)
    # must come per request, never from prepare — or the release won't boot
    # (found before deploying, 2026-11-02)
    test "the link preview isn't in the prepared copy; each request adds it", %{conn: conn} do
      HoodrideWeb.PageController.prepare(
        files("<html><head></head><body>PREPARED</body></html>", ~s(const CACHE = "x";))
      )

      refute :persistent_term.get({HoodrideWeb.PageController, :index}) =~ "og:"
      html = conn |> get("/") |> html_response(200)
      assert html =~ "PREPARED"
      assert html =~ ~s(<meta property="og:url" content="#{HoodrideWeb.Endpoint.url()}/">)
    end

    test "not prepared (dev, test): read from disk on every request", %{conn: conn} do
      HoodrideWeb.PageController.forget()
      html = conn |> get("/") |> html_response(200)
      refute html =~ "PREPARED"
      assert html =~ "app.js", "the real index.html, from disk"
    end

    test "prod prepares at start-up; dev doesn't (its edits show on a reload)" do
      prod = Config.Reader.read!("config/prod.exs", env: :prod)
      assert prod[:hoodride][:prepare_pages_at_boot] == true
      dev = Config.Reader.read!("config/dev.exs", env: :dev)
      assert dev[:hoodride][:prepare_pages_at_boot] in [nil, false]
    end
  end

  describe "the app is told" do
    test "the map channel's join reply carries the build" do
      {:ok, u} =
        Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "bt-u", name: "B"})

      {:ok, socket} =
        Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
          connect_info: %{session: Hoodride.TestHelpers.session_for(u.id)}
        )

      assert {:ok, %{build: build}, _} = subscribe_and_join(socket, "world", %{})
      assert build == Build.current()
    end

    test "the app and the server agree on the wire protocol number" do
      app = File.read!(Path.join(@static, "app.js"))
      [_, n] = Regex.run(~r/^const PROTOCOL = (\d+);/m, app)
      assert String.to_integer(n) == HoodrideWeb.WorldChannel.protocol()
    end
  end
end
