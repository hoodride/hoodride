defmodule HoodrideWeb.PageController do
  use HoodrideWeb, :controller

  alias Hoodride.I18n
  alias HoodrideWeb.{Build, Lang, StaticVersions}

  # The page, stamped with the build it belongs to (HoodrideWeb.Build): the
  # app compares it with the server's build after every reconnect. Served
  # here (not by Plug.Static) for "/" AND "/index.html", so no unstamped
  # copy exists for the offline cache to keep.
  # sobelow_skip ["XSS.SendResp"]
  def index(conn, _params) do
    lang = Lang.pick(conn)

    conn
    |> Lang.vary()
    |> put_resp_content_type("text/html")
    |> send_resp(200, page() |> with_link_preview() |> with_languages() |> in_language(lang))
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
  defp with_link_preview(html),
    do: String.replace(html, "</head>", link_preview() <> "</head>", global: false)

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
  def privacy(conn, params), do: legal(conn, "privacy", params)

  # The Terms of Use (Hoodride.Terms): public, like the privacy policy, and
  # styled by the same privacy.css
  def terms(conn, params), do: legal(conn, "terms", params)

  # the legal pages are whole documents, translated and reviewed as one
  # (stage 2): `privacy.es.html` beside `privacy.html` — English if a
  # language has none yet. (Our own files, by names fixed here and a
  # language from Lang.pick — one of Hoodride.I18n's own tags.)
  # A translated page links to its English original (it's what applies):
  # `?lang=en` — English whatever the language cookie says. Only "en": any
  # other value is ignored, the page as usual.
  # sobelow_skip ["XSS.SendResp"]
  defp legal(conn, name, params) do
    lang = if params["lang"] == "en", do: "en", else: Lang.pick(conn)

    conn
    |> Lang.vary()
    |> put_resp_content_type("text/html")
    |> send_resp(200, StaticVersions.stamp(static(legal_file(name, lang))))
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
  defp link_preview do
    base = HoodrideWeb.Endpoint.url()
    image = base <> "/og.png?vsn=" <> (StaticVersions.of("og.png") || "")

    [
      {"name", "description", @preview_line},
      {"property", "og:type", "website"},
      {"property", "og:site_name", "Hood Ride"},
      {"property", "og:title", "Hood Ride"},
      {"property", "og:description", @preview_line},
      {"property", "og:url", base <> "/"},
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
