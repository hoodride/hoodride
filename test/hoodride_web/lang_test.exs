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
      assert lang(asking("fr-FR,fr;q=0.9,en-XA;q=0.8")) == "en-XA"
      assert lang(asking("en;q=0.9,en-XA")) == "en-XA", "by weight, not by place"
      assert lang(asking("en-XA;q=0,en")) == "en", "q=0: not this one"
      assert lang(asking("de,fr")) == "en", "none of ours: English"
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
