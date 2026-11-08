defmodule HoodrideWeb.ResumingTest do
  # Signed in, the app's page starts neutral — only the car — instead of the
  # sign-in screen that /api/state replaced a moment later (owner,
  # 2026-11-05: "why does changing languages show the sign in page for a
  # brief moment"). PageController.resuming; styles.css html.resuming.
  use HoodrideWeb.ConnCase, async: true

  # a real sign-in (Hoodride.SessionTokens), made `age` ms ago
  defp signed_in(conn, age \\ 0) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "google",
        provider_id: "res-#{System.unique_integer([:positive])}",
        name: "Ana"
      })

    session = Hoodride.TestHelpers.session_for(u.id)
    init_test_session(conn, Hoodride.TestHelpers.age_sign_in(session, age))
  end

  defp html_tag(conn), do: Regex.run(~r/<html[^>]*>/, conn.resp_body) |> hd()

  test "signed in: every home page starts neutral, and says it depends on the cookie" do
    for path <- ["/", "/index.html", "/ja", "/ar"] do
      conn = build_conn() |> signed_in() |> get(path)
      assert conn.status == 200, path
      assert html_tag(conn) =~ ~s(class="resuming"), path
      [vary] = get_resp_header(conn, "vary")
      assert vary =~ "Cookie", path
    end

    # the language and direction kept
    tag = build_conn() |> signed_in() |> get("/ar") |> html_tag()
    assert tag =~ ~s(lang="ar") and tag =~ ~s(dir="rtl")
  end

  test "signed out, or the sign-in expired: the sign-in screen, as before" do
    expired = 31 * 86_400_000

    for conn <- [build_conn(), build_conn() |> signed_in(expired)], path <- ["/", "/ja"] do
      conn = get(conn, path)
      assert conn.status == 200, path
      refute html_tag(conn) =~ "resuming", path
    end
  end

  test "reading the sign-in sets no cookie of its own" do
    conn = build_conn() |> get("/")
    assert get_resp_header(conn, "set-cookie") == []
  end

  test "neutral = only the car; the message only after a second" do
    css = File.read!("priv/static/styles.css")

    assert css =~
             "html.resuming #screen-login > :not(.brand):not(.boot-status),\nhtml.resuming #screen-login .brand > :not(.brand-car) {\n  visibility: hidden;\n}"

    assert css =~
             "html.resuming #screen-login .boot-status {\n  animation: boot-late 0s linear 1s both;"

    assert css =~
             ~r/@keyframes boot-late \{\s+from \{ visibility: hidden; \}\s+to \{ visibility: visible; \}/
  end

  test "the app ends it: on any screen shown, and on a real 'signed out'" do
    js = File.read!("priv/static/app.js")
    [show] = Regex.run(~r/function show\(screenId\) \{.*?\n\}/s, js)
    ends = ~s{document.documentElement.classList.remove("resuming")}
    assert show =~ ends
    [signed_out] = Regex.run(~r/onSignedOut: async \(\) => \{.*?\n  \},/s, js)
    assert signed_out =~ ends
  end
end
