defmodule HoodrideWeb.LoadFailTest do
  @moduledoc """
  The "couldn't load" message (owner, 2026-11-19: one phone's
  sendfilter.js never arrived, and the app sat broken with no word): it
  shows when one of the app's files didn't arrive (HoodLoadCheck,
  loadcheck.js) — so its words can't wait for the files that translate the
  page. The server writes them in the reader's language
  (PageController.with_load_fail); "Try again" is a plain link to the same
  page. The browser side: test_browser/loadfail.mjs.
  """
  use HoodrideWeb.ConnCase, async: true

  # pages only, no database: never holds its ONE connection (ConnCase) —
  # untagged, a page made slow by the whole suite held it seconds while
  # tests queued behind it were dropped (precommit, 2026-11-22)
  @moduletag db: false

  alias Hoodride.I18n
  alias HoodrideWeb.PageController

  @english "Couldn't load Hood Ride — check your connection"
  @old "Your browser is too old for Hood Ride — update it to continue"

  test "English: the message as written, hidden, with a link back to this page", %{conn: conn} do
    body = get(conn, "/").resp_body
    assert body =~ ~s(<div id="load-fail" class="load-fail" role="alert" hidden>)
    assert body =~ ~s(<p class="load-fail-text">#{@english}</p>)
    assert body =~ ~r{<a id="load-fail-retry" class="btn btn-primary" href="">Try again</a>}
    # (a browser too old for our code: this instead — HoodLoadCheck)
    assert body =~ ~s(<p class="load-fail-old" hidden>#{@old}</p>)
  end

  test "another language: both words in it, from the server — no script needed" do
    for lang <- I18n.known() -- ["en"] do
      body = PageController.with_load_fail(page(), lang)
      text = Plug.HTML.html_escape(I18n.t(lang, @english))
      again = Plug.HTML.html_escape(I18n.t(lang, "Try again"))
      assert body =~ ~s(<p class="load-fail-text">#{text}</p>), lang
      assert body =~ ~s(href="">#{again}</a>), lang
      old = Plug.HTML.html_escape(I18n.t(lang, @old))
      assert body =~ ~s(<p class="load-fail-old" hidden>#{old}</p>), lang
    end
  end

  test "the page itself, opened in Japanese, carries them", %{conn: conn} do
    body = get(conn, "/ja").resp_body
    text = Plug.HTML.html_escape(I18n.t("ja", @english))
    assert text != @english
    assert body =~ ~s(<p class="load-fail-text">#{text}</p>)
    assert body =~ ~s(href="">#{Plug.HTML.html_escape(I18n.t("ja", "Try again"))}</a>)
    assert body =~ ~s(>#{Plug.HTML.html_escape(I18n.t("ja", @old))}</p>)
  end

  test "every language has the message translated (none falls back to English)" do
    for lang <- I18n.known() -- ["en", "en-XA"] do
      refute I18n.t(lang, @english) == @english, "#{lang}: not translated"
      refute I18n.t(lang, @old) == @old, "#{lang}: 'too old' not translated"
    end
  end

  test "the page's last script is the load check, and the reporter its first", %{conn: conn} do
    body = get(conn, "/").resp_body
    scripts = Regex.scan(~r{<script src="([^"?]+)}, body) |> Enum.map(&List.last/1)
    assert List.first(scripts) == "errors.js"
    # each the app's own by its version stamp (errors.js counts only those)
    for src <- Regex.scan(~r{<script src="([^"]+)"}, body) |> Enum.map(&List.last/1),
        do: assert(src =~ ~r{\.js\?vsn=[0-9a-f]+$}, "#{src}: no version stamp")

    assert List.last(scripts) == "loadcheck.js"
  end

  # (thirteenth review) over everything on the browsers it's FOR — the old
  # ones: `inset` (Chrome 87, Safari 14.1) and flex `gap` (Safari 14.1)
  # ignored there; the four edges and margins every browser knows
  test "the message box covers the screen on old browsers too" do
    css = File.read!("priv/static/styles.css")
    [_, rule] = Regex.run(~r/\.load-fail \{([^}]*)\}/, css)
    rule = Regex.replace(~r{/\*.*?\*/}s, rule, "")
    for edge <- ~w(top right bottom left), do: assert(rule =~ ~r/\b#{edge}: 0;/, edge)
    refute rule =~ ~r/\bgap:/
  end

  test "the load check is served, and kept for offline", %{conn: conn} do
    assert get(conn, "/loadcheck.js").status == 200
    assert File.read!("priv/static/sw.js") =~ ~s("loadcheck.js")
  end

  defp page, do: File.read!("priv/static/index.html")
end
