defmodule HoodrideWeb.CSPTest do
  @moduledoc """
  The full Content-Security-Policy (OWASP CSP cheat sheet, web.dev "strict
  CSP"; owner's go, 2026-10-28): the second lock against injected code —
  if a bug ever let a message run as code, the browser wouldn't run it,
  and nothing could be sent anywhere but Hood Ride and the map server.

  `script-src 'self'`, not nonces: the page has NO inline scripts and no
  other site's scripts (guarded below), so only our own files can run —
  OWASP's tighter baseline. Rolled out the standard way: report-only in
  prod first (`config :hoodride, :csp_report_only`), reports to
  /api/csp-report, then enforced. Clickjacking ('frame-ancestors') is
  enforced throughout.

  REPORTING IS OFF (owner, 2026-10-29: it mostly carried browser-extension
  noise, and its one real catch — Cloudflare adding a script — is now an
  after-deploy check). `config :hoodride, :csp_reporting` switches it back on;
  these tests keep both states working.
  """
  use HoodrideWeb.ConnCase, async: false

  import ExUnit.CaptureLog

  alias HoodrideWeb.CSP

  setup do
    on_exit(fn ->
      Application.delete_env(:hoodride, :csp_report_only)
      Application.delete_env(:hoodride, :csp_reporting)
    end)
  end

  defp reporting_on, do: Application.put_env(:hoodride, :csp_reporting, true)

  defp header(conn, name) do
    case get_resp_header(conn, name) do
      [v] -> v
      [] -> nil
    end
  end

  describe "the policy" do
    test "only Hood Ride and the map server; no plugins, no <base>, forms to us only" do
      p = CSP.policy()

      for rule <- [
            "default-src 'self'",
            "style-src 'self'",
            "img-src 'self' data: blob:",
            # the offline service worker (sw.js, ours) AND the map's worker (blob:)
            # — 'self' was missing at first: Chrome refused to register sw.js
            "worker-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'"
          ],
          do: assert(p =~ rule, "missing: #{rule}")

      # scripts: our own files, Cloudflare Web Analytics' beacon, which
      # Cloudflare adds to the page (owner's pick, 2026-10-28 — named in the
      # privacy policy), and Cloudflare Turnstile's check on the sign-in
      # screen (2026-11-14, HoodrideWeb.Turnstile). Exactly these three:
      # nobody else's scripts.
      [script] = Regex.run(~r/script-src [^;]+/, p)

      assert script ==
               "script-src 'self' https://static.cloudflareinsights.com https://challenges.cloudflare.com"

      # frames: Turnstile's check runs in one — and nothing else
      [frame] = Regex.run(~r/frame-src [^;]+/, p)
      assert frame == "frame-src https://challenges.cloudflare.com"

      [connect] = Regex.run(~r/connect-src [^;]+/, p)
      assert connect =~ "'self'"
      assert connect =~ "https://tiles.openfreemap.org"
      # the live socket by name (older Safari doesn't count ws/wss as 'self')
      assert connect =~ ~r{wss?://}
      # never a bare "https:" or "wss:" (any site would do); data: and blob:
      # are the page's own generated pictures and the map's worker
      bare = for t <- String.split(p, ~r/[\s;]+/), t =~ ~r/^[a-z]+:$/, uniq: true, do: t
      assert Enum.sort(bare) == ["blob:", "data:"]
      refute p =~ "unsafe-inline"
      refute p =~ "unsafe-eval"
      refute p =~ ~r/\*/
      # reporting off: no report lines at all
      refute p =~ "report-"
    end

    test "reporting switched on: the report lines come back" do
      reporting_on()
      assert CSP.policy() =~ "report-uri /api/csp-report"
      assert CSP.policy() =~ "report-to csp"
    end
  end

  describe "enforced (dev, tests — and prod once the reports are clean)" do
    for path <- ["/", "/privacy", "/app.js", "/api/me"] do
      test "#{path} carries it", %{conn: conn} do
        conn = get(conn, unquote(path))
        assert header(conn, "content-security-policy") == CSP.policy()
        assert header(conn, "reporting-endpoints") == nil, "reporting is off"
      end
    end

    test "reporting switched on: browsers are told where to report", %{conn: conn} do
      reporting_on()
      assert header(get(conn, "/"), "reporting-endpoints") == ~s(csp="/api/csp-report")
    end
  end

  describe "report-only (prod's first step)" do
    test "the full policy only reports; clickjacking stays blocked", %{conn: conn} do
      Application.put_env(:hoodride, :csp_report_only, true)
      conn = get(conn, "/")
      assert header(conn, "content-security-policy") == "frame-ancestors 'none'"
      assert header(conn, "content-security-policy-report-only") == CSP.policy()
    end
  end

  describe "the pages give it nothing to allow" do
    test "no inline scripts, styles, handlers or javascript: links" do
      for page <- ["priv/static/index.html", "priv/static/privacy.html"] do
        html = File.read!(page)
        refute html =~ ~r/<script(?![^>]*\ssrc=)[^>]*>/, "#{page}: inline <script>"
        refute html =~ "<style", "#{page}: inline <style>"
        refute html =~ ~r/\son[a-z]+=/, "#{page}: inline on…= handler"
        refute html =~ ~r/\sstyle=/, "#{page}: style= attribute"
        refute html =~ "javascript:", "#{page}: javascript: link"
      end
    end

    test "the privacy page's look is a file of its own, versioned", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      v = HoodrideWeb.StaticVersions.current()["privacy.css"]
      assert v
      # from the root: the same page also lives at /ja/privacy (2026-11-05)
      assert html =~ ~s(href="/privacy.css?vsn=#{v}")
      assert get(build_conn(), "/privacy.css").status == 200
    end
  end

  describe "the photo route" do
    test "keeps its own stricter policy (sandboxed)", %{conn: conn} do
      # signed out: refused — the header is what matters here
      conn = get(conn, "/avatars/aaaaaaaaaaaaaaaaaaaaaa.jpg")
      assert header(conn, "x-frame-options") == "DENY"
    end
  end

  describe "reporting off: the endpoint isn't there" do
    test "a report gets 404 and nothing is logged", %{conn: conn} do
      body =
        Jason.encode!(%{
          "csp-report" => %{
            "effective-directive" => "img-src",
            "blocked-uri" => "https://x.example"
          }
        })

      log =
        capture_log(fn ->
          conn =
            conn
            |> put_req_header("content-type", "application/csp-report")
            |> post("/api/csp-report", body)

          assert conn.status == 404
        end)

      refute log =~ "csp:"
    end
  end

  describe "violation reports (switched on)" do
    setup do
      reporting_on()
      :ok
    end

    defp report(body, type) do
      build_conn()
      |> put_req_header("content-type", type)
      |> post("/api/csp-report", body)
    end

    test "the old format: logged as directive + site only — no page, no path, no query" do
      body =
        Jason.encode!(%{
          "csp-report" => %{
            "document-uri" => "https://hoodride.app/?secret=1",
            "violated-directive" => "script-src-elem",
            "effective-directive" => "script-src-elem",
            "blocked-uri" => "https://evil.example/x.js?token=abc"
          }
        })

      log = capture_log(fn -> assert report(body, "application/csp-report").status == 204 end)
      assert log =~ "csp: script-src-elem blocked https://evil.example"
      refute log =~ "x.js"
      refute log =~ "token"
      refute log =~ "secret"
    end

    test "the new format (report-to: a list)" do
      body =
        Jason.encode!([
          %{
            "type" => "csp-violation",
            "body" => %{
              "documentURL" => "https://hoodride.app/",
              "effectiveDirective" => "connect-src",
              "blockedURL" => "wss://evil.example/socket"
            }
          }
        ])

      log = capture_log(fn -> assert report(body, "application/reports+json").status == 204 end)
      assert log =~ "csp: connect-src blocked wss://evil.example"
    end

    test "a site name with a newline or junk: logged as 'other' — a report can't forge a log line" do
      for uri <- ["https://a\n[error] forged line", "https://a b.example/", "https://\e[31mred/"] do
        body =
          Jason.encode!(%{
            "csp-report" => %{"effective-directive" => "img-src", "blocked-uri" => uri}
          })

        log = capture_log(fn -> assert report(body, "application/csp-report").status == 204 end)
        refute log =~ "forged"
        refute log =~ "\e["
        assert log =~ "csp: img-src blocked other", inspect(uri)
      end
    end

    test "inline and eval reports name the kind, not a site" do
      body =
        Jason.encode!(%{
          "csp-report" => %{"effective-directive" => "script-src-elem", "blocked-uri" => "inline"}
        })

      log = capture_log(fn -> report(body, "application/csp-report") end)
      assert log =~ "csp: script-src-elem blocked inline"
    end

    test "junk, or too big: refused quietly, never a crash" do
      assert report("not json", "application/csp-report").status == 400
      assert report(String.duplicate("x", 70_000), "application/csp-report").status in [400, 413]
      assert report(Jason.encode!(%{"nope" => 1}), "application/csp-report").status == 204
    end
  end
end
