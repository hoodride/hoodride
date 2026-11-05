defmodule HoodrideWeb.PageController do
  use HoodrideWeb, :controller

  alias Hoodride.I18n
  alias HoodrideWeb.{Build, Lang, StaticVersions}

  # The page, stamped with the build it belongs to (HoodrideWeb.Build): the
  # app compares it with the server's build after every reconnect. Served
  # here (not by Plug.Static) for "/" AND "/index.html", so no unstamped
  # copy exists for the offline cache to keep.
  #
  # Every language has its own address (owner, 2026-11-05 — Google: "different
  # URLs for each language version", in subdirectories): English at /, Japanese
  # at /ja, … Only the home page sends a visitor to their language (the
  # language cookie, then the phone's): Google names an auto-redirecting home
  # page as the x-default, and advises against redirecting any other page —
  # /privacy is the English policy for everyone, /ja/privacy the Japanese one.
  # The query is kept (?refresh= after a sign-in, ?demo=1).
  def index(conn, _params) do
    case Lang.pick(conn) do
      "en" ->
        conn |> Lang.vary() |> Lang.renew() |> home("en")

      lang ->
        conn |> Lang.vary() |> Lang.renew() |> redirect(to: address(lang, "") <> query(conn))
    end
  end

  @doc "The English page whatever the visitor's language: /index.html, the offline copy's own."
  def english_index(conn, _params), do: home(conn, "en")

  @doc "/ja, /pt-BR…: the app in that language. Any other first segment: not found."
  def lang_index(conn, %{"lang" => tag} = params) do
    with_language(conn, params, tag, "", &home(&1, &2))
  end

  # sobelow_skip ["XSS.SendResp"]
  defp home(conn, lang) do
    html =
      page()
      |> with_link_preview(address(lang, ""))
      |> with_languages()
      |> with_alternates("", lang, I18n.addressed())
      |> localize_links(lang)
      |> in_language(lang)
      |> resuming(signed_in?(conn))

    conn
    # (the page now depends on the sign-in cookie too: Vary says so)
    |> Lang.vary()
    |> Lang.renew()
    |> put_resp_content_type("text/html")
    |> send_resp(200, html)
  end

  # Signed in (a session cookie that still holds a sign-in — no database
  # read): the page starts NEUTRAL, the car on dark, not on the sign-in
  # screen that /api/state would replace a moment later (owner, 2026-11-05:
  # changing language flashed the sign-in screen). The app (app.js) then
  # shows the map, the Terms, or — the sign-in really over — the sign-in
  # screen. "Don't guess on the server: render a pending state" (the
  # standard fix for a flash of signed-out content; Remix: the session read
  # before the page is sent). A hint only: the app decides.
  defp signed_in?(conn) do
    conn |> fetch_session() |> get_session() |> HoodrideWeb.Auth.session_user() != nil
  end

  @doc "The page starting neutral (`resuming`) for someone signed in."
  def resuming(html, false), do: html

  def resuming(html, true),
    do: String.replace(html, "<html lang=", ~s(<html class="resuming" lang=), global: false)

  # a language address, checked: one switched on → `serve`; the same in other
  # capitals (/JA, /pt-br) → its own spelling; /en… → the English address;
  # a trailing slash → without; anything else → not found
  defp with_language(conn, params, tag, rest, serve) do
    langs = Enum.reject(I18n.on(), &(&1 == "en"))
    own = Enum.find(langs, &(String.downcase(&1) == String.downcase(tag)))

    cond do
      String.downcase(tag) == "en" ->
        conn |> put_status(301) |> redirect(to: address("en", rest) <> query(conn))

      own == nil ->
        not_found(conn, params)

      own != tag or String.ends_with?(conn.request_path, "/") ->
        conn |> put_status(301) |> redirect(to: address(own, rest) <> query(conn))

      true ->
        serve.(conn, own)
    end
  end

  @doc "The address of a page (`rest`: empty, `/privacy` or `/terms`) in a language."
  def address("en", ""), do: "/"
  def address("en", rest), do: rest
  def address(lang, rest), do: "/" <> lang <> rest

  defp query(%Plug.Conn{query_string: ""}), do: ""
  defp query(%Plug.Conn{query_string: q}), do: "?" <> q

  @doc """
  The page's alternates for search engines (Google's hreflang rules): the
  same full list on every version — English, each language with its own
  address, and x-default (English: the page a visitor without a language of
  ours gets) — and the page's own address as canonical (never another
  language's).
  """
  def with_alternates(html, rest, lang, langs) do
    base = HoodrideWeb.Endpoint.url()

    links =
      [{"en", address("en", rest)} | Enum.map(langs, &{&1, address(&1, rest)})]
      |> Enum.map_join(fn {tag, path} ->
        ~s(  <link rel="alternate" hreflang="#{tag}" href="#{base}#{path}">\n)
      end)

    head =
      ~s(  <link rel="canonical" href="#{base}#{address(lang, rest)}">\n) <>
        links <>
        ~s(  <link rel="alternate" hreflang="x-default" href="#{base}#{address("en", rest)}">\n)

    String.replace(html, "</head>", head <> "</head>", global: false)
  end

  @doc """
  A page's own links in its language: home, the terms and the privacy
  policy (the files link to "/", "/terms", "/privacy" — one file per page
  for every language). Only those exact addresses: the note's link to the
  English original ("/privacy?lang=en") stays English.
  """
  def localize_links(html, "en"), do: html

  def localize_links(html, lang) do
    Regex.replace(~r{href="(/|/terms|/privacy)"}, html, fn _, path ->
      ~s(href="#{address(lang, if(path == "/", do: "", else: path))}")
    end)
  end

  @doc """
  A page in `lang` (HoodrideWeb.Lang, Hoodride.I18n): its `<html lang>`,
  and that language's catalog script right after i18n.js — loaded before
  the app runs, it translates the page's marked words (HoodI18n). English:
  the page as it is.
  """
  def in_language(html, "en"), do: html

  def in_language(html, lang) do
    html
    |> String.replace(
      ~s(<html lang="en">),
      # (right-to-left languages: the whole page mirrors — styles.css uses
      # start/end, never left/right)
      if(I18n.rtl?(lang),
        do: ~s(<html lang="#{lang}" dir="rtl">),
        else: ~s(<html lang="#{lang}">)
      ),
      global: false
    )
    |> then(
      &Regex.replace(~r{<script src="(/?)i18n\.js(\?vsn=[^"]*)?"></script>}, &1, fn tag,
                                                                                    root,
                                                                                    _ ->
        tag <>
          "\n  " <> StaticVersions.stamp(~s(<script src="#{root}#{I18n.script(lang)}"></script>))
      end)
    )
  end

  # added per request, not in prepare/1: in prod the page is prepared at
  # start-up BEFORE the Endpoint starts, and Endpoint.url() raises then
  # (checked 2026-11-02) — the release would not have booted
  defp with_link_preview(html, path),
    do: String.replace(html, "</head>", link_preview(path) <> "</head>", global: false)

  # the languages switched on, for the page's language switch (HoodLang;
  # one alone: no switch) — per request, as LANGUAGES is read at start-up
  defp with_languages(html) do
    meta = ~s(  <meta name="hoodride-languages" content="#{Enum.join(I18n.on(), ",")}">
)
    String.replace(html, "</head>", meta <> "</head>", global: false)
  end

  # An address that doesn't exist: a real 404 — Google ignores a 4xx page
  # and never indexes it, and scanners stop reporting "/.env found"
  # (owner, 2026-10-30) — with a page that SAYS so and leads home
  # (notfound.html, owner 2026-11-02; it used to be the app, silently on the
  # map). The address stays as typed.
  # sobelow_skip ["XSS.SendResp"]
  def not_found(conn, _params) do
    lang = Lang.pick(conn)

    conn
    |> Lang.vary()
    |> Lang.renew()
    |> put_resp_content_type("text/html")
    |> send_resp(404, "notfound.html" |> static() |> StaticVersions.stamp() |> in_language(lang))
  end

  defp page, do: prepared(:index) || stamp_page(static("index.html"))

  # The service worker, its cache named after the build: a new build is a
  # changed worker, which the browser installs and which wipes the old
  # caches — no hand-bumped "hoodride-vNN". "no-cache" so the browser always
  # asks for it fresh (that's how it finds updates).
  def service_worker(conn, _params) do
    js = prepared(:sw) || stamp_worker(static("sw.js"))

    conn
    |> put_resp_content_type("application/javascript")
    |> put_resp_header("cache-control", "no-cache")
    |> send_resp(200, js)
  end

  # The privacy policy: public (no sign-in), on the app's own domain and
  # linked from the login screen and the drawer — Google's rules for the
  # policy its consent screen links to. Plain HTML, no app code; its look is
  # privacy.css, by versioned address (no inline <style> — HoodrideWeb.CSP).
  def privacy(conn, _params), do: legal(conn, "privacy", "en")

  # The Terms of Use (Hoodride.Terms): public, like the privacy policy, and
  # styled by the same privacy.css
  def terms(conn, _params), do: legal(conn, "terms", "en")

  @doc "/ja/privacy, /ja/terms: the translated policy and terms."
  def lang_privacy(conn, %{"lang" => tag} = params),
    do: with_language(conn, params, tag, "/privacy", &legal(&1, "privacy", &2))

  def lang_terms(conn, %{"lang" => tag} = params),
    do: with_language(conn, params, tag, "/terms", &legal(&1, "terms", &2))

  # the legal pages are whole documents, translated as one: `privacy.ja.html`
  # beside `privacy.html` (English if a language had none). /privacy and
  # /terms are English for everyone — no redirect (Google: don't redirect
  # between language versions); a translated page notes that the English
  # applies and links to it ("/privacy?lang=en": the English page, the
  # parameter now changes nothing). Every version links to the others (the
  # language row) and names them for search engines (alternates).
  # (Our own files, by names fixed here and a language from the list.)
  # sobelow_skip ["XSS.SendResp"]
  defp legal(conn, name, lang) do
    html =
      static(legal_file(name, lang))
      # the files ask for "privacy.css" (beside them): from /ja/privacy that
      # would be /ja/privacy.css — from the root instead, whatever the address
      |> String.replace(~s(href="privacy.css"), ~s(href="/privacy.css"))
      |> StaticVersions.stamp()
      |> with_alternates("/" <> name, lang, I18n.addressed())
      |> localize_links(lang)
      |> with_language_row("/" <> name, lang, I18n.addressed())

    conn
    |> Lang.renew()
    |> put_resp_content_type("text/html")
    |> send_resp(200, html)
  end

  @doc """
  The legal pages' language list (Google: "let the user switch the page
  language"), under the back link: one line, "Language", that opens (a
  plain <details> — these pages run no code) to every version by its own
  name, the one shown marked as current. Search engines see the links
  either way.
  """
  def with_language_row(html, rest, lang, langs) do
    links =
      ["en" | langs]
      |> Enum.map_join(" · ", fn tag ->
        current = if tag == lang, do: ~s( aria-current="page"), else: ""
        dir = if I18n.rtl?(tag), do: ~s( dir="rtl"), else: ""

        ~s(<a href="#{address(tag, rest)}" lang="#{tag}" hreflang="#{tag}"#{dir}#{current}>) <>
          Plug.HTML.html_escape(I18n.name(tag)) <> "</a>"
      end)

    label = Plug.HTML.html_escape(I18n.t(lang, "Language"))

    row =
      ~s(\n  <details class="lang-row"><summary>#{label}: #{Plug.HTML.html_escape(I18n.name(lang))}</summary><p>) <>
        links <> "</p></details>"

    Regex.replace(~r{(<a class="back" href="[^"]*">[^<]*</a>)}, html, "\\1" <> row, global: false)
  end

  @doc "The legal page's file for `lang`: its own if there is one, else English."
  def legal_file(name, lang, exists? \\ &File.regular?/1) do
    own = "#{name}.#{lang}.html"

    if lang != "en" and exists?.(Application.app_dir(:hoodride, Path.join("priv/static", own))),
      do: own,
      else: "#{name}.html"
  end

  @doc """
  PROD (`config :hoodride, :prepare_pages_at_boot`, called from Application):
  stamp the page and sw.js ONCE, at start-up, and keep them — the running
  server then serves exactly the version it started with, even if files on
  disk change under it (a deploy copying files before the restart would
  otherwise send NEW code under the OLD build tag). Dev doesn't: there,
  edits to index.html and sw.js show on a reload. `read` is for tests.
  """
  def prepare(read \\ &static/1) do
    # first: the stamps below carry these fingerprints
    StaticVersions.prepare()
    :persistent_term.put({__MODULE__, :index}, stamp_page(read.("index.html")))
    :persistent_term.put({__MODULE__, :sw}, stamp_worker(read.("sw.js")))
    :ok
  end

  @doc false
  def forget do
    StaticVersions.forget()
    :persistent_term.erase({__MODULE__, :index})
    :persistent_term.erase({__MODULE__, :sw})
    :ok
  end

  defp prepared(which), do: :persistent_term.get({__MODULE__, which}, nil)

  # every app file by its versioned address (StaticVersions), the build, and
  # the sign-ins on offer (AuthController.providers/0: a button shows only
  # for a provider that works — no dead button)
  defp stamp_page(html) do
    providers = Enum.join(HoodrideWeb.AuthController.providers(), ",")

    String.replace(
      StaticVersions.stamp(html),
      "</head>",
      ~s(  <meta name="hoodride-build" content="#{Build.current()}">\n) <>
        ~s(  <meta name="hoodride-providers" content="#{providers}">\n</head>),
      global: false
    )
  end

  # The link preview (owner, 2026-11-02): what Facebook, iMessage, WhatsApp,
  # X… show for a shared address — Open Graph (ogp.me) and X's large card.
  # Addresses in full (Facebook needs them), from the server's own (PHX_HOST),
  # the picture by versioned address so a saved preview refreshes when it
  # changes (og.png; source assets/og/). The line is the sign-in screen's.
  @preview_line "Rides from your neighborhood"
  defp link_preview(path) do
    base = HoodrideWeb.Endpoint.url()
    image = base <> "/og.png?vsn=" <> (StaticVersions.of("og.png") || "")

    [
      {"name", "description", @preview_line},
      {"property", "og:type", "website"},
      {"property", "og:site_name", "Hood Ride"},
      {"property", "og:title", "Hood Ride"},
      {"property", "og:description", @preview_line},
      {"property", "og:url", base <> path},
      {"property", "og:image", image},
      {"property", "og:image:width", "1200"},
      {"property", "og:image:height", "630"},
      {"property", "og:image:alt", "Hood Ride: " <> @preview_line},
      {"name", "twitter:card", "summary_large_image"}
    ]
    |> Enum.map_join(fn {attr, key, value} ->
      ~s(  <meta #{attr}="#{key}" content="#{Plug.HTML.html_escape(value)}">\n)
    end)
  end

  # the offline cache stores the same versioned addresses the page asks for
  # (offline, a request finds only an exact match)
  defp stamp_worker(js) do
    Regex.replace(~r/^const CACHE = "[^"]*";/m, StaticVersions.stamp(js), fn _ ->
      ~s(const CACHE = "hoodride-#{Build.current()}";)
    end)
  end

  # file names are compile-time constants above; no user input reaches here
  # sobelow_skip ["Traversal.FileModule"]
  defp static(name),
    do: File.read!(Application.app_dir(:hoodride, Path.join("priv/static", name)))
end
