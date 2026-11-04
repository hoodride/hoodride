defmodule HoodrideWeb.SecurityHeadersTest do
  @moduledoc """
  Browser protections on EVERY answer — pages, scripts, the API — set in the
  endpoint before static files (found missing on deploy day, 2026-10-28):

    * no framing (clickjacking: a fake site can't lay Hood Ride under its own
      buttons) — X-Frame-Options for old browsers, CSP frame-ancestors for new
    * no type guessing (nosniff)
    * the address never leaves for other sites (Referrer-Policy same-origin:
      map tiles and Google Maps don't learn where a click came from)

  A full Content-Security-Policy (scripts, map tiles) is a separate job.
  """
  use HoodrideWeb.ConnCase, async: false

  @expected [
    {"x-frame-options", "DENY"},
    {"x-content-type-options", "nosniff"},
    {"referrer-policy", "same-origin"}
  ]

  for path <- [
        "/",
        "/privacy",
        "/sw.js",
        "/app.js",
        "/styles.css",
        "/api/me",
        "/api/nope",
        "/any/page"
      ] do
    test "#{path} carries them", %{conn: conn} do
      conn = get(conn, unquote(path))

      for {name, value} <- @expected,
          do: assert(get_resp_header(conn, name) == [value], "#{unquote(path)}: #{name}")

      # never framed — enforced even while the full policy only reports
      # (the full policy itself: csp_test.exs)
      [csp] = get_resp_header(conn, "content-security-policy")
      assert csp =~ "frame-ancestors 'none'"
    end
  end

  test "a photo answer is never frameable either", %{conn: conn} do
    # signed out: refused — the photo's own stricter CSP (sandbox) is
    # avatar_serving_test's
    conn = get(conn, "/avatars/aaaaaaaaaaaaaaaaaaaaaa.jpg")
    assert get_resp_header(conn, "x-frame-options") == ["DENY"]
  end
end
