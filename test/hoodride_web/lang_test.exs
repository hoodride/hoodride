defmodule HoodrideWeb.LangTest do
  @moduledoc """
  Which language someone sees (stage 1f, 2026-11-04): the one they picked,
  else their browser's, else English — among those switched on — and every
  page served in it. (Tests switch on the made-up en-XA: config/test.exs.)
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.I18n
  alias HoodrideWeb.{Lang, PageController}

  defp lang(conn), do: Lang.pick(conn)
  defp asking(header), do: build_conn() |> put_req_header("accept-language", header)

  describe "picking" do
    test "the browser's languages, best first; a language alone matches its regions" do
      assert lang(build_conn()) == "en"
      assert lang(asking("en-XA")) == "en-XA"
      assert lang(asking("en-xa,en;q=0.5")) == "en-XA"

      assert lang(asking("eo,eu;q=0.9,en-XA;q=0.8")) == "en-XA",
             "none of the first two: the third"

      assert lang(asking("fr-FR,fr;q=0.9,en-XA;q=0.8")) == "fr"
      assert lang(asking("en;q=0.9,en-XA")) == "en-XA", "by weight, not by place"
      assert lang(asking("en-XA;q=0,en")) == "en", "q=0: not this one"
      assert lang(asking("eo,la")) == "en", "none of ours: English"
    end

    # (Spanish isn't here yet: the matching rule itself, on a list given)
    test "one tag: exact, else its language alone, never a sibling region — whatever the order" do
      for on <- [["en", "es", "en-XA"], ["en-XA", "es", "en"]] do
        assert Lang.match("es-MX", on) == "es"
        assert Lang.match("ES", on) == "es"
        assert Lang.match("en-xa", on) == "en-XA"
        assert Lang.match("en-US", on) == "en"
        assert Lang.match("en-XB", on) == "en"
        assert Lang.match("fr-FR", on) == nil
      end

      assert Lang.match("en-US", ["en-XA"]) == nil
    end

    # (languages, stage 2: the tags phones actually send)
    test "Chinese by script, Norwegian, Filipino, Portugal, old codes" do
      on = ["en", "zh-Hans", "zh-Hant", "nb", "fil", "pt-BR", "he", "id", "en-XA"]

      for {asked, got} <- [
            {"zh-CN", "zh-Hans"},
            {"zh-SG", "zh-Hans"},
            {"zh", "zh-Hans"},
            {"zh-Hans-CN", "zh-Hans"},
            {"zh-TW", "zh-Hant"},
            {"zh-HK", "zh-Hant"},
            {"zh-MO", "zh-Hant"},
            {"zh-Hant", "zh-Hant"},
            {"no", "nb"},
            {"nn-NO", "nb"},
            {"nb-NO", "nb"},
            {"tl", "fil"},
            {"fil-PH", "fil"},
            {"pt-PT", "pt-BR"},
            {"pt", "pt-BR"},
            {"iw", "he"},
            {"in-ID", "id"},
            {"en-GB", "en"},
            {"en-XA", "en-XA"}
          ] do
        assert Lang.match(asked, on) == got,
               "#{asked} → #{inspect(Lang.match(asked, on))}, expected #{got}"
      end

      # the made-up language only by its own exact tag
      assert Lang.match("en-US", ["en-XA"]) == nil
    end

    test "another region of English is English — never the made-up en-XA" do
      assert lang(asking("en-US,en;q=0.9")) == "en"
      assert lang(asking("en-GB")) == "en"
    end

    test "an explicit pick (the cookie) comes first; one not switched on is ignored" do
      picked = fn value -> asking("en") |> put_req_cookie(Lang.cookie(), value) end
      assert lang(picked.("en-XA")) == "en-XA"
      assert lang(asking("en-XA") |> put_req_cookie(Lang.cookie(), "en")) == "en"
      assert lang(picked.("xx")) == "en"
      assert lang(picked.("../../etc")) == "en"
    end

    test "only languages switched on" do
      before = Application.get_env(:hoodride, :languages)
      Application.put_env(:hoodride, :languages, ["en"])

      try do
        assert lang(asking("en-XA")) == "en"
      after
        Application.put_env(:hoodride, :languages, before)
      end
    end

    test "a messy header doesn't break anything" do
      for h <- [
            "",
            ",,,",
            "*",
            "en-XA;q=abc",
            "en-XA;q=2",
            "<script>",
            String.duplicate("x,", 500)
          ] do
        assert lang(asking(h)) in ["en", "en-XA"], h
      end

      assert Lang.preferred("da, en-gb;q=0.8, en;q=0.7") == ["da", "en-gb", "en"]
    end
  end

  describe "serving" do
    test "the app in English: the page as it is", %{conn: conn} do
      conn = get(conn, "/")
      html = html_response(conn, 200)
      assert html =~ ~s(<html lang="en">)
      refute html =~ "i18n-"
      assert get_resp_header(conn, "vary") == ["Accept-Language, Cookie"]
    end

    test "the app in another language: <html lang>, and its catalog right after i18n.js, before the app" do
      html = asking("en-XA") |> get("/") |> html_response(200)
      assert html =~ ~s(<html lang="en-XA">)
      v = HoodrideWeb.StaticVersions.of("i18n-en-XA.js")

      assert html =~
               ~r{<script src="i18n\.js\?vsn=\w+"></script>\n  <script src="i18n-en-XA\.js\?vsn=#{v}"></script>}

      {catalog, _} = :binary.match(html, "i18n-en-XA.js")
      {app, _} = :binary.match(html, ~s(<script src="app.js))
      assert catalog < app
    end

    # the language switch's list: the languages switched on (one alone —
    # the page shows no switch: app.js renderLangSwitch)
    test "the page lists the languages switched on" do
      html = build_conn() |> get("/") |> html_response(200)
      on = Hoodride.I18n.on() |> Enum.join(",")
      assert html =~ ~s(<meta name="hoodride-languages" content="#{on}">)

      before = Application.get_env(:hoodride, :languages)
      Application.put_env(:hoodride, :languages, ["en"])

      try do
        assert build_conn() |> get("/") |> html_response(200) =~
                 ~s(<meta name="hoodride-languages" content="en">)
      after
        Application.put_env(:hoodride, :languages, before)
      end
    end

    # Arabic, Hebrew, Urdu read right to left: the whole page mirrors
    # (owner, 2026-11-05)
    test "a right-to-left language: the page served dir=rtl; the others not" do
      for lang <- ~w(ar he ur) do
        assert asking(lang) |> get("/") |> html_response(200) =~
                 ~s(<html lang="#{lang}" dir="rtl">)
      end

      for lang <- ~w(en es ja) do
        refute asking(lang) |> get("/") |> html_response(200) =~ ~s(dir="rtl")
      end
    end

    # it mirrors by itself only if nothing is pinned to a side: start/end,
    # never left/right, for what isn't symmetric (a centered or full-width
    # thing — left: 0 with right: 0, left: 50% — is the same either way)
    test "the styles mirror: no one-sided left/right" do
      css = File.read!("priv/static/styles.css") |> String.replace(~r{/\*.*?\*/}s, "")

      for bad <- [
            ~r/margin-(left|right)\s*:/,
            ~r/padding-(left|right)\s*:/,
            ~r/text-align\s*:\s*(left|right)/,
            ~r/border-(top|bottom)-(left|right)-radius/,
            ~r/(?<![-\w])float\s*:/
          ] do
        refute css =~ bad, "#{inspect(bad)}: use start/end (inline) so right-to-left pages mirror"
      end

      # a lone `right:` (or `left:`) pins one side: allowed only beside its
      # pair (full width) or as a centred 50%
      for [rule] <- Regex.scan(~r/\{[^}]*\}/, css),
          one =
            Regex.match?(~r/(?<![-\w])right\s*:/, rule) !=
              Regex.match?(~r/(?<![-\w])left\s*:/, rule),
          one do
        # (or a spot inside a symmetric bubble — the pile's icons at 26/50/74%:
        # mirrored they'd only swap identical icons)
        assert rule =~ ~r/left\s*:\s*\d+%/, "pinned to one side: #{String.slice(rule, 0, 120)}"
      end
    end

    test "the page for an address that doesn't exist: in the language too" do
      conn = asking("en-XA") |> get("/no/such/page")
      html = html_response(conn, 404)
      assert html =~ ~s(<html lang="en-XA">)

      assert html =~
               ~r{<script src="/i18n\.js\?vsn=\w+"></script>\n  <script src="/i18n-en-XA\.js\?vsn=\w+"></script>}

      assert get_resp_header(conn, "vary") == ["Accept-Language, Cookie"]
      english = build_conn() |> get("/no/such/page") |> html_response(404)
      assert english =~ ~s(<html lang="en">)
      refute english =~ "i18n-"
    end

    # at /no/such/page a relative "privacy.css" was looked for in /no/such/:
    # the page showed unstyled, no car, no words in another language (found
    # 2026-11-04). Its files from the root, versioned (a <base> is refused
    # by the CSP)
    test "the not-found page names its files from the root, versioned" do
      html = build_conn() |> get("/no/such/page") |> html_response(404)

      files =
        Regex.scan(~r/(?:src|href)="([^"]+)"/, html, capture: :all_but_first) |> List.flatten()

      assert files != []

      for f <- files do
        assert String.starts_with?(f, "/"), "#{f}: from the root"
        if f != "/", do: assert(f =~ ~r/\?vsn=\w+$/, "#{f}: versioned")
      end
    end

    test "the legal pages: a language's own document if it has one, else English" do
      has = fn files -> fn path -> Path.basename(path) in files end end

      assert PageController.legal_file("privacy", "es", has.(["privacy.es.html"])) ==
               "privacy.es.html"

      assert PageController.legal_file("privacy", "es", has.([])) == "privacy.html"
      assert PageController.legal_file("terms", "en", has.(["terms.en.html"])) == "terms.html"

      for page <- ["/privacy", "/terms"] do
        conn = asking("en-XA") |> get(page)
        assert html_response(conn, 200) =~ ~s(<html lang="en">), "no en-XA document: English"
        assert get_resp_header(conn, "vary") == ["Accept-Language, Cookie"]
      end
    end

    test "the server's own words: the sign-in limit's message in the reader's language" do
      msg = "Too many failed sign-ins from your network — try again later."
      assert I18n.t("en-XA", msg) != msg
      # (the message as served: Hoodride.I18n.t, collected like the app's)
      assert File.read!("priv/gettext/default.pot") =~ ~s(msgid "#{msg}")

      assert File.read!("lib/hoodride_web/controllers/auth_controller.ex") =~
               ~s[Hoodride.I18n.t(lang, "#{msg}")]
    end
  end
end
