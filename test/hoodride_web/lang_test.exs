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
      on = [
        "en",
        "zh-Hans",
        "zh-Hant",
        "nb",
        "fil",
        "pt-BR",
        "he",
        "id",
        "en-XA",
        "ht",
        "so",
        "am",
        "fa",
        "hmn"
      ]

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
            {"en-XA", "en-XA"},
            # the five added 2026-11-05: the codes browsers send for them
            {"ht", "ht"},
            {"ht-HT", "ht"},
            {"so-SO", "so"},
            {"so-KE", "so"},
            {"am-ET", "am"},
            {"fa-IR", "fa"},
            {"fa-AF", "fa"},
            {"prs", "fa"},
            {"prs-AF", "fa"},
            {"hmn", "hmn"},
            {"hmn-US", "hmn"},
            {"mww", "hmn"},
            {"hnj", "hmn"}
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
      html = build_conn() |> get("/en-XA") |> html_response(200)
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
      for lang <- ~w(ar he ur fa) do
        assert build_conn() |> get("/" <> lang) |> html_response(200) =~
                 ~s(<html lang="#{lang}" dir="rtl">)
      end

      for path <- ~w(/ /es /ja) do
        refute build_conn() |> get(path) |> html_response(200) =~ ~s(dir="rtl")
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
    end

    test "the legal pages: /privacy and /terms English for everyone; /ja/privacy Japanese" do
      for page <- ["/privacy", "/terms"] do
        # no redirect between language versions (Google): the address decides
        for conn <- [asking("ja"), asking("en") |> put_req_cookie(Lang.cookie(), "es")] do
          html = conn |> get(page) |> html_response(200)
          assert html =~ ~s(<html lang="en">)
          refute html =~ "translation-note"
        end

        ja = build_conn() |> put_req_cookie(Lang.cookie(), "es") |> get("/ja" <> page)
        html = html_response(ja, 200)
        assert html =~ ~s(<html lang="ja">), "the address decides, not the cookie"
        # its style from the root: from /ja/privacy, "privacy.css" would be
        # /ja/privacy.css, not there (the language journey found it)
        assert html =~ ~r/href="\/privacy\.css\?vsn=\w+"/
        # the note's link: the English original ("?lang=en" — still English)
        assert html =~ ~s(<a href="#{page}?lang=en">)

        assert build_conn() |> get(page <> "?lang=en") |> html_response(200) =~
                 ~s(<html lang="en">)
      end
    end
  end

  # each language's own addresses (owner, 2026-11-05 — Google: separate URLs
  # per language, in subdirectories; only the home page redirects; hreflang
  # on every version; each canonical to itself)
  describe "addresses" do
    test "/: English stays; any other language is sent to its own home, the query kept" do
      en = asking("en-US") |> get("/")
      assert html_response(en, 200) =~ ~s(<html lang="en">)
      assert get_resp_header(en, "vary") == ["Accept-Language, Cookie"]

      ja = asking("ja") |> get("/")
      assert redirected_to(ja, 302) == "/ja"
      assert get_resp_header(ja, "vary") == ["Accept-Language, Cookie"]

      # the language chosen (cookie) before the phone's; English chosen: stays
      assert asking("ja") |> put_req_cookie(Lang.cookie(), "es") |> get("/") |> redirected_to(302) ==
               "/es"

      assert asking("ja") |> put_req_cookie(Lang.cookie(), "en") |> get("/") |> html_response(200) =~
               ~s(<html lang="en">)

      # a sign-in's note (?refresh=) and the demo go along
      assert asking("pt-BR") |> get("/?refresh=failed") |> redirected_to(302) ==
               "/pt-BR?refresh=failed"

      assert asking("ar") |> get("/?demo=1") |> redirected_to(302) == "/ar?demo=1"
    end

    test "a language's address shows that language, whatever the cookie or the phone" do
      for path <- ["/ja", "/ja/privacy", "/ja/terms"] do
        conn = asking("de") |> put_req_cookie(Lang.cookie(), "es") |> get(path)
        assert html_response(conn, 200) =~ ~s(<html lang="ja">), path
      end
    end

    test "other spellings go to the address's own; not a language: not found" do
      for {from, to} <- [
            {"/JA", "/ja"},
            {"/pt-br", "/pt-BR"},
            {"/zh-hant/terms", "/zh-Hant/terms"},
            {"/ja/", "/ja"},
            {"/en", "/"},
            {"/EN/privacy", "/privacy"},
            {"/en/terms?x=1", "/terms?x=1"}
          ] do
        assert build_conn() |> get(from) |> redirected_to(301) == to, from
      end

      for path <- ["/xx", "/xx/privacy", "/ja/nope", "/zzz/terms", "/.env"] do
        assert build_conn() |> get(path) |> response(404), path
      end
    end

    test "a language not switched on has no address (and / never sends anyone to it)" do
      before = Application.get_env(:hoodride, :languages)
      Application.put_env(:hoodride, :languages, ["en", "es"])

      try do
        assert build_conn() |> get("/es") |> html_response(200) =~ ~s(<html lang="es">)
        assert build_conn() |> get("/ja") |> response(404)
        assert build_conn() |> get("/ja/privacy") |> response(404)
        assert asking("ja") |> get("/") |> html_response(200) =~ ~s(<html lang="en">)
        refute build_conn() |> get("/es") |> html_response(200) =~ ~s(hreflang="ja")
      after
        Application.put_env(:hoodride, :languages, before)
      end
    end

    test "/index.html, the offline copy's own: English, never a redirect" do
      html =
        asking("ja")
        |> put_req_cookie(Lang.cookie(), "es")
        |> get("/index.html")
        |> html_response(200)

      assert html =~ ~s(<html lang="en">)
    end

    # Google's hreflang rules: every version lists itself and every other
    # one, the same list on each (else ignored), full addresses, x-default
    test "every version names all the versions, the same list on each; canonical: itself" do
      base = HoodrideWeb.Endpoint.url()
      langs = I18n.addressed()
      refute "en-XA" in langs, "the test language is never announced"
      assert length(langs) >= 45

      for {rest, paths} <- [
            {"", ["/", "/ja", "/ar", "/pt-BR"]},
            {"/privacy", ["/privacy", "/ja/privacy"]},
            {"/terms", ["/terms", "/zh-Hant/terms"]}
          ] do
        expected =
          [{"en", base <> PageController.address("en", rest)}] ++
            Enum.map(langs, &{&1, base <> PageController.address(&1, rest)}) ++
            [{"x-default", base <> PageController.address("en", rest)}]

        for path <- paths do
          html = build_conn() |> get(path) |> html_response(200)

          found =
            Regex.scan(~r/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/, html,
              capture: :all_but_first
            )

          assert Enum.map(found, &List.to_tuple/1) == expected, path
          assert html =~ ~s(<link rel="canonical" href="#{base}#{path}">), path
          assert length(Regex.scan(~r/rel="canonical"/, html)) == 1, path
        end
      end
    end

    test "a page's own links stay in its language; the note's English link stays English" do
      ja = build_conn() |> get("/ja") |> html_response(200)
      assert ja =~ ~s(href="/ja/terms") and ja =~ ~s(href="/ja/privacy")
      refute ja =~ ~s(href="/terms") or ja =~ ~s(href="/privacy")
      assert ja =~ ~s(<meta property="og:url" content="#{HoodrideWeb.Endpoint.url()}/ja">)

      terms = build_conn() |> get("/ja/terms") |> html_response(200)
      assert terms =~ ~s(<a class="back" href="/ja">)
      assert terms =~ ~s(href="/ja/privacy")
      assert terms =~ ~s(href="/terms?lang=en")

      en = build_conn() |> get("/") |> html_response(200)
      assert en =~ ~s(href="/terms") and en =~ ~s(href="/privacy")
    end

    test "the legal pages list every version by its own name, the current one marked" do
      for {path, lang} <- [{"/privacy", "en"}, {"/ja/terms", "ja"}, {"/ar/privacy", "ar"}] do
        html = build_conn() |> get(path) |> html_response(200)
        [row] = Regex.run(~r{<details class="lang-row">.*?</details>}s, html)

        links =
          Regex.scan(~r{<a href="([^"]+)" lang="([^"]+)" hreflang="[^"]+"[^>]*>([^<]+)</a>}, row,
            capture: :all_but_first
          )

        assert length(links) == 1 + length(I18n.addressed()), path
        assert ["/ja" <> _, "ja", "日本語"] = Enum.find(links, fn [_, l, _] -> l == "ja" end)

        assert [[^lang]] =
                 Regex.scan(~r{lang="([^"]+)"[^>]*aria-current="page"}, row,
                   capture: :all_but_first
                 )

        assert row =~ "<summary>#{I18n.t(lang, "Language")}: #{I18n.name(lang)}</summary>"
        # right under the back link
        assert html =~ ~r{<a class="back" href="[^"]*">[^<]*</a>\n  <details class="lang-row">}
      end
    end
  end

  # the picked language kept by the SERVER, renewed on every page (owner,
  # 2026-11-05): Safari caps a cookie written by the page at 7 days (WebKit,
  # ITP 2.1); sent in the response it lives its year, from the last visit
  # Amharic's script for phones without a font for it (owner, 2026-11-05)
  test "the Ethiopic font: declared only for Ethiopic letters, in both stylesheets, and served" do
    for {css, prefix} <- [{"priv/static/styles.css", ""}, {"priv/static/privacy.css", "/"}] do
      text = File.read!(css)
      faces = Regex.scan(~r/@font-face \{[^}]*\}/, text) |> List.flatten()
      assert length(faces) == 2, css

      for face <- faces do
        assert face =~ ~s(font-family: "Noto Sans Ethiopic")
        # an installed copy (Android, Linux) before the download (MDN:
        # "local files should appear before remote files")
        assert face =~
                 ~r/src: local\("Noto Sans Ethiopic (Regular|Bold)"\), local\("NotoSansEthiopic-\1"\),\s+url\("#{prefix}fonts\/NotoSansEthiopic-\1\.ttf"\)/

        # only Ethiopic: nobody else ever downloads it
        assert face =~ "unicode-range: U+1200-139F, U+2D80-2DDF, U+AB01-AB2E, U+1E7E0-1E7FE;"
      end

      # the device's own Ethiopic fonts first (Windows' Ebrima and Nyala,
      # Apple's Kefa): no download when it has one — after the Latin fonts
      # (Ebrima has Latin letters too; English must not change font)
      assert text =~
               ~r/font(-family)?:[^;]*"Segoe UI", Roboto, Ebrima, Nyala, Kefa, "Noto Sans Ethiopic", sans-serif;/,
             "#{css}: in the font list"
    end

    for f <- ~w(NotoSansEthiopic-Regular.ttf NotoSansEthiopic-Bold.ttf) do
      conn = build_conn() |> get("/fonts/" <> f)
      assert conn.status == 200, f
      assert <<0, 1, 0, 0, _::binary>> = conn.resp_body
    end
  end

  describe "the language cookie" do
    defp lang_cookie(conn) do
      conn
      |> get_resp_header("set-cookie")
      |> Enum.find(&String.starts_with?(&1, Lang.cookie() <> "="))
    end

    test "a picked language: sent back by the server on every page, for a year, the whole site" do
      for path <- ["/", "/es", "/ja", "/privacy", "/ja/terms", "/no/such/page"] do
        conn = asking("en") |> put_req_cookie(Lang.cookie(), "es") |> get(path)
        set = lang_cookie(conn)
        assert set, "#{path}: not renewed"
        assert set =~ ~r/^hoodride_lang=es;/
        assert set =~ "max-age=31536000"
        assert set =~ "path=/"
        assert set =~ ~r/SameSite=Lax/i
        refute set =~ ~r/HttpOnly/i, "the page may read it (a language, not a secret)"
      end
    end

    test "in its own spelling; nothing picked, or not a language switched on: nothing set" do
      assert asking("en")
             |> put_req_cookie(Lang.cookie(), "PT-br")
             |> get("/privacy")
             |> lang_cookie() =~
               ~r/^hoodride_lang=pt-BR;/

      for value <- [nil, "zz", "", "../x"] do
        conn =
          if value, do: asking("ja") |> put_req_cookie(Lang.cookie(), value), else: asking("ja")

        assert conn |> get("/ja") |> lang_cookie() == nil, inspect(value)
      end
    end

    # OWASP WSTG-SESS-02 (cookie attributes) and Cloudflare's caching rules
    # (owner, 2026-11-05: "missing any?")
    test "Secure on the https site; not on a local http one (it would never be sent)" do
      conn = asking("en") |> put_req_cookie(Lang.cookie(), "es") |> Plug.Conn.fetch_cookies()

      assert Lang.renew(conn, "https://hoodride.app").resp_cookies[Lang.cookie()].secure == true
      assert Lang.renew(conn, "http://localhost:4000").resp_cookies[Lang.cookie()].secure == false

      # the default: the site's own address
      expected = String.starts_with?(HoodrideWeb.Endpoint.url(), "https:")
      assert Lang.renew(conn).resp_cookies[Lang.cookie()].secure == expected
    end

    test "no Domain: hoodride.app's own cookie, never shared with a subdomain" do
      for path <- ["/", "/ja", "/privacy"] do
        set = asking("en") |> put_req_cookie(Lang.cookie(), "es") |> get(path) |> lang_cookie()
        refute set =~ ~r/domain=/i, "#{path}: #{set}"
      end
    end

    test "every page that renews it is private — no shared cache may keep one person's cookie" do
      for path <- ["/", "/es", "/ja", "/privacy", "/ja/terms", "/no/such/page"] do
        conn = asking("en") |> put_req_cookie(Lang.cookie(), "es") |> get(path)
        assert lang_cookie(conn), path
        [cache] = get_resp_header(conn, "cache-control")
        assert cache =~ "private", "#{path}: #{cache}"
      end
    end

    test "a pick comes back from the server at once — the page's own 7-day cookie replaced" do
      # the switch writes the cookie and opens the language's page: that
      # very answer carries the server's cookie
      conn = build_conn() |> put_req_cookie(Lang.cookie(), "fr") |> get("/fr")
      assert lang_cookie(conn) =~ ~r/^hoodride_lang=fr;.*max-age=31536000/
    end
  end

  describe "the server's words" do
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
