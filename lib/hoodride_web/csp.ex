defmodule HoodrideWeb.CSP do
  @moduledoc """
  The Content-Security-Policy: what the browser may load, run and send to
  (OWASP CSP cheat sheet; web.dev "strict CSP"). The second lock against
  injected code — messages and names are already shown as text, never code;
  if a bug ever let one run, the browser refuses it, and nothing could be
  sent anywhere but Hood Ride and the map server.

    * scripts and styles: our own files only — the pages have no inline
      scripts, styles or handlers (csp_test.exs keeps it so), so `'self'` is
      the whole list (OWASP's tighter baseline; Google's nonces are for pages
      with inline or other sites' scripts, which these don't have) — plus
      Cloudflare Web Analytics' beacon, which Cloudflare adds to the page on
      its way out (owner's pick, 2026-10-28; named in the privacy policy;
      Cloudflare's CSP table). Its counts go back to our own /cdn-cgi/rum,
      which 'self' already allows.
    * connections: Hood Ride, its live socket by name (older Safari doesn't
      count ws/wss as 'self'), and the map server (style, tiles, fonts, icons)
    * pictures: ours, the generated 🙂 placeholders (data:), the map's
      (blob:); workers: the offline service worker (ours) and the map
      library's (blob:)
    * no plugins, no <base>, forms to us only, never inside another site

  Rolled out the standard way: report-only first in prod
  (`config :hoodride, :csp_report_only`), violations to /api/csp-report
  (CspReportController), enforced once clean. 'frame-ancestors' is enforced
  throughout.

  REPORTING IS OFF (owner, 2026-10-29): it mostly carried browser-extension
  noise (Brave Shields: ~30 per page), and its one real catch — Cloudflare
  adding a script on the way out — is now deploy/cloudflare_check.sh, run
  by deploy.sh. Blocking is unchanged. `config :hoodride, :csp_reporting,
  true` brings the report lines and /api/csp-report back — but only
  together with flood protection (a budget of its own, a total cap, hourly
  counts instead of a line per report), which isn't built.
  """

  @map "https://tiles.openfreemap.org"
  @web_analytics "https://static.cloudflareinsights.com"
  # Cloudflare Turnstile on the sign-in screen: its script, and the frame
  # its check runs in (Cloudflare's CSP page; HoodrideWeb.Turnstile)
  @turnstile "https://challenges.cloudflare.com"

  @doc "The full policy."
  def policy do
    Enum.join(
      [
        "default-src 'self'",
        "script-src 'self' #{@web_analytics} #{@turnstile}",
        "style-src 'self'",
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self' #{socket_origin()} #{@map}",
        "worker-src 'self' blob:",
        "child-src blob:",
        "frame-src #{@turnstile}",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'"
      ] ++ if(reporting?(), do: ["report-uri /api/csp-report", "report-to csp"], else: []),
      "; "
    )
  end

  @doc "Violation reports on? (off: see the moduledoc)"
  def reporting?, do: Application.get_env(:hoodride, :csp_reporting, false)

  @doc "The headers every answer carries (Endpoint)."
  def headers do
    report = if reporting?(), do: [{"reporting-endpoints", ~s(csp="/api/csp-report")}], else: []

    if Application.get_env(:hoodride, :csp_report_only, false),
      do: [
        {"content-security-policy", "frame-ancestors 'none'"},
        {"content-security-policy-report-only", policy()} | report
      ],
      else: [{"content-security-policy", policy()} | report]
  end

  # wss://hoodride.app in prod (the endpoint's public address)
  defp socket_origin do
    %URI{scheme: scheme, host: host, port: port} = HoodrideWeb.Endpoint.struct_url()
    ws = if scheme == "https", do: "wss", else: "ws"
    default = if scheme == "https", do: 443, else: 80
    if port in [nil, default], do: "#{ws}://#{host}", else: "#{ws}://#{host}:#{port}"
  end
end
