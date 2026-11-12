defmodule HoodrideWeb.PrivacyTest do
  @moduledoc """
  Collect less, and say so plainly.

    * No email: nothing used it — the account is the provider's id. Google is
      asked for `openid profile` only (its User Data Policy: the narrowest
      scopes), and stored emails are gone.
    * Prod logs no request lines (warnings and errors only); journald keeps
      14 days, in daily files (deploy/journald-hoodride.conf).
    * /privacy: public, linked from the login screen (Google's home-page
      rule: same domain, linked from it and from the consent screen) and the
      drawer. Operator Hood Ride, contact@hoodride.app, USA, 18+; CalOPPA's Do
      Not Track and third-party-tracking statements; an effective date.
  """
  use HoodrideWeb.ConnCase, async: false

  describe "no email" do
    test "the users table has no email column" do
      {:ok, %{rows: rows}} = Hoodride.Repo.query("PRAGMA table_info(users)")
      refute "email" in Enum.map(rows, &Enum.at(&1, 1))
      refute :email in Hoodride.Accounts.User.__schema__(:fields)
    end

    test "Google is asked for openid and profile only", %{conn: conn} do
      Application.put_env(:hoodride, :google_client_id, "test-client")
      on_exit(fn -> Application.delete_env(:hoodride, :google_client_id) end)
      %URI{query: q} = conn |> get("/auth/google") |> redirected_to(302) |> URI.parse()
      assert URI.decode_query(q)["scope"] == "openid profile"
    end

    test "/api/me and /api/state don't carry an email", %{conn: conn} do
      {:ok, u} =
        Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "pv-me", name: "Pv"})

      conn =
        init_test_session(conn, Hoodride.TestHelpers.session_for(u.id))

      refute Map.has_key?(json_response(get(conn, "/api/me"), 200)["user"], "email")
      refute Map.has_key?(json_response(get(conn, "/api/state"), 200)["user"], "email")
    end
  end

  describe "logs" do
    test "prod logs no request lines; dev does" do
      assert Config.Reader.read!("config/prod.exs", env: :prod)[:hoodride][:request_log] == false

      assert Config.Reader.read!("config/dev.exs", env: :dev)[:hoodride][:request_log] in [
               nil,
               :info
             ]
    end

    test "journald keeps 14 days, in daily files, installed by setup.sh" do
      conf = File.read!("deploy/journald-hoodride.conf")
      assert conf =~ ~r/^\[Journal\]/m
      assert conf =~ ~r/^MaxRetentionSec=14day$/m
      assert conf =~ ~r/^MaxFileSec=1day$/m
      setup = File.read!("deploy/setup.sh")
      assert setup =~ "/etc/systemd/journald.conf.d/hoodride.conf"
    end
  end

  describe "the privacy policy" do
    test "is public (no sign-in), and says what the law and Google ask", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)

      for must <- [
            "Privacy Policy",
            "Hood Ride",
            "contact@hoodride.app",
            "18",
            "Do Not Track",
            "Effective",
            "Delete account",
            "Cloudflare",
            "OpenFreeMap",
            "Google"
          ],
          do: assert(html =~ must, "missing: #{must}")

      refute html =~ ~r/email address you sign in with/i
      # none kept since 2026-11-12 (the delete loop)
      refute html =~ ~r/sign-out records/i
      # the contact address is on the domain (owner, 2026-10-31): Cloudflare
      # Email Routing forwards contact@hoodride.app to the owner's Gmail (it
      # receives only once hoodride.app is bought and routed — ARCHITECTURE.md)
      refute html =~ ~r/[a-z0-9.]+@gmail\.com/i
    end

    # 5 rows since 2026-10-29: IP addresses and sign-out records split — one
    # "a few minutes up to 30 days" row read as "IPs kept 30 days". IPs live
    # only in memory (rate budgets, swept once full again; none in the logs);
    # sign-out records hold an account number and a time, for 30 days
    # (Hoodride.SignOuts, the session's 30 days). 6 since 2026-11-08: sign-in
    # records (Hoodride.SessionTokens: one per signed-in device, 30 days after
    # last use, a year at most). 5 again since 2026-11-12: no sign-out records
    # are kept any more (nothing read them; the delete loop piled them up)
    test "how long we keep it: plain kinds, each with a limit (owner's pick, 2026-10-28)", %{
      conn: conn
    } do
      html = conn |> get("/privacy") |> html_response(200)
      [_, body] = Regex.run(~r/How long we keep it.*?<tbody>(.*?)<\/tbody>/s, html)

      rows =
        Regex.scan(~r/<tr><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/s, body, capture: :all_but_first)

      assert [
               ["Your account" <> _, "Until you delete your account"],
               ["Live info" <> _, live],
               ["IP addresses (to stop abuse)", "A few minutes, never saved"],
               [
                 "Sign-in records (one per signed-in device, to keep you signed in)",
                 "Until you sign out, or 30 days after you last use the app (at most a year)"
               ],
               ["Error logs", "14 days"]
             ] = rows

      assert live =~ "Minutes"
      # never the vague "as long as necessary"
      refute body =~ ~r/as long as/i
    end

    test "visit counting is named honestly: Cloudflare Web Analytics, no cookies", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      assert html =~ "Cloudflare Web Analytics"
      assert html =~ ~r/no cookies/i
      # the old promise is gone — it would now be untrue
      refute html =~ ~r/don't [^.]*use analytics/i
    end

    # The page promises: "If we change this policy, we'll update this page
    # and its effective date." So the date is pinned here — change the page,
    # change this date with it (2026-10-29: Google only, one area wording,
    # Refresh from Google; 2026-10-30: which messages you've read;
    # 2026-10-31: sign-out takes you off the map, "open Settings";
    # 2026-11-05: the language cookie, kept only if you choose)
    test "the effective date is the date of the last change", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      assert html =~ "Effective November 5, 2026"
    end

    # the language switch (owner, 2026-11-05): its cookie listed, and kept
    # only on a choice
    test "lists the language cookie: only if you choose", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      assert html =~ "If you choose a language, a cookie remembers your choice for a year"

      assert html =~
               "if you don't choose, the app follows your phone's language and stores nothing"

      assert File.read!("priv/static/langswitch.js") =~ "max-age=31536000"
    end

    # what sign-out does on the server (AuthController.logout, owner
    # 2026-10-31): off the map at once; refused in a ride or a waiting request
    test "signing out: all devices, off the map, not during a ride", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      [line] = Regex.run(~r{<li><strong>Sign out</strong>.*?</li>}s, html)

      assert line ==
               "<li><strong>Sign out</strong> signs you out on all your devices and takes you off the map. " <>
                 "(If you're in a ride or waiting for one, end or cancel it first.)</li>"
    end

    # how to delete says where the button is (the anchor is the "data
    # deletion instructions" link): "your profile picture", as Google's help
    # names its own (owner, 2026-11-03) — everyone has one there, a photo or
    # their initial (avatar.js); not "Settings": no screen shows the word
    test "deleting: says where the button is", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      [section] = Regex.run(~r{<h2 id="delete-account">.*?</p>}s, html)

      assert section =~
               "You can delete your account at any time: tap your profile picture at the top left, then <strong>Delete account</strong>."

      refute html =~ ~r/tap your photo/i
      refute html =~ "round button"
    end

    # the app keeps a "read up to" bookmark per chat on the device so new
    # messages show as unread (HoodReadStore) — the page lists what the
    # device keeps, and signing out removes it too
    test "what the device remembers includes which messages you've read", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      [device] = Regex.run(~r{<strong>On your device:</strong>.*?</p>}s, html)
      assert device =~ "which messages you've read"
      assert device =~ "Signing out removes them."
    end

    # Facebook sign-in isn't offered (Meta needs a verified business —
    # owner, 2026-10-29): the page names only what's real. The anchor stays,
    # stable, for any provider's "data deletion instructions" link
    test "Google is the only sign-in named; the delete-account anchor stays", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      assert html =~ ~s(id="delete-account")
      # what a reader sees (not the page's own <meta> tags)
      text = html |> String.replace(~r/<[^>]*>/s, " ")
      refute text =~ ~r/facebook|\bmeta\b/i
    end

    test "your name and photo update when you sign in, or with Refresh from Google", %{
      conn: conn
    } do
      html = conn |> get("/privacy") |> html_response(200)
      assert html =~ "Refresh from Google"
    end

    # the map's area and the area sent with a message are the SAME grid cell
    # (H3 resolution 9: ~105,000 m², ~350 m across) — one description, not
    # "350 m" in one row and "about a block" in another (owner, 2026-10-29)
    test "both location rows describe the same ~350 m area", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      assert length(Regex.scan(~r/350 m \(about a quarter mile\) across/, html)) == 2
      refute html =~ "about a block"
    end

    # (18+ stays in the Terms and on this page; the sign-in line just links
    # them — owner, 2026-10-31)
    test "is linked from the login screen", %{conn: conn} do
      html = conn |> get("/") |> html_response(200)
      assert html =~ ~s(href="/privacy")

      assert html =~
               ~s(<p class="fineprint" data-t>By continuing, you agree to our <a href="/terms" data-t data-t-slot="terms">Terms</a> and <a href="/privacy" data-t data-t-slot="privacy">Privacy Policy</a>.</p>)
    end

    # open to people anywhere (owner, 2026-10-31): GDPR Article 13's items,
    # in plain words, for the EU, the UK and Switzerland
    test "a GDPR section with what Article 13 asks for", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)

      [section] =
        Regex.run(
          ~r{<h2 id="gdpr">If you're in the EU, the UK or Switzerland</h2>(.*?)<h2}s,
          html,
          capture: :all_but_first
        )

      # (how to delete, as the app shows it: no screen says "Settings")
      refute section =~ "Settings"

      for must <- [
            "contact@hoodride.app",
            # the legal bases
            "To provide the service you signed up for",
            "Our legitimate interests",
            # the rights, and how
            "ask for a copy of your information",
            "correct it",
            "delete it",
            "restrict it",
            "object to how we use it",
            "portable form",
            "within one month",
            "complain to your local data protection authority",
            # transfers
            "servers are in the United States",
            "EU-U.S. Data Privacy Framework",
            "Standard Contractual Clauses",
            # required or not; automated decisions; how long
            "needed for the app to work",
            "No automated decisions",
            "How long we keep it"
          ],
          do: assert(section =~ must, "missing: #{must}")
    end

    # no in-app notice exists for privacy changes: the page promises only
    # what happens (owner's pick, 2026-10-31)
    test "changes: the page and its date, no promise of an in-app notice", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      assert html =~ "If we change this policy, we'll update this page and its effective date."
      refute html =~ ~r/tell you in the app/i
    end

    # no screen in the app says "Settings" (your profile picture at the top
    # left opens it): the page names what people actually see (owner,
    # 2026-10-31; "profile picture", 2026-11-03)
    test "never sends people to 'Settings'", %{conn: conn} do
      html = conn |> get("/privacy") |> html_response(200)
      text = html |> String.replace(~r/<[^>]*>/s, " ")
      refute text =~ "Settings"
      assert html =~ "(tap your profile picture at the top left, then <em>Change</em>)"

      assert html =~
               "(your profile picture at the top left, then <strong>Delete account</strong>)"

      refute html =~ "round button"
      assert html =~ "as you set them in the app, so they can find you"
    end

    # the map-app box says where to change it, in the same words (owner,
    # 2026-11-03): no screen says "Settings"
    test "the app never sends people to 'Settings' either" do
      html = File.read!("priv/static/index.html")
      [sheet] = Regex.run(~r/<div id="nav-sheet".*?<\/div>/s, html)

      assert sheet =~
               ~s(Change it anytime: tap your profile picture at the top left, then <strong data-t data-t-slot="setting">Navigation app</strong>)

      # what a person sees: no comments, no tags
      text =
        html
        |> String.replace(~r/<!--.*?-->/s, " ")
        |> String.replace(~r/<[^>]*>/s, " ")

      refute text =~ "Settings"
      refute text =~ "round button"
    end

    # nor any message the app shows (every one is in the translators' list):
    # Google refresh's failure said "open Settings" until 2026-11-04. The
    # only "Settings" are the screen-reader names of the profile button and
    # the drawer's list ("Settings", "Settings ({name})"), and the
    # PHONE's or browser's Settings as a step in a menu path
    # ("Settings › Privacy & Security › …" — location help)
    test "no message the app shows sends people to the app's 'Settings'" do
      {:ok, pot} = Expo.PO.parse_file("priv/gettext/default.pot")
      ids = Enum.map(pot.messages, &IO.iodata_to_binary(&1.msgid))

      assert "Couldn't refresh automatically — tap your profile picture at the top left, then Change, then Refresh from Google" in ids

      ours =
        Enum.filter(ids, &(String.replace(&1, ~r/Settings ›/, "") =~ "Settings"))

      assert ours == ["Settings", "Settings ({name})"]
      # (the location help is in the list: the rule above really looks at it)
      assert Enum.any?(ids, &(&1 =~ "Settings › Privacy & Security"))
      refute Enum.any?(ids, &(&1 =~ "round button"))
    end

    test "is linked from the drawer" do
      html = File.read!("priv/static/index.html")
      [drawer] = Regex.run(~r/<aside id="settings-sheet".*?<\/aside>/s, html)
      assert drawer =~ ~s(href="/privacy")

      # delete account: a small link BELOW sign out, beside the policy — a
      # rare, permanent action shouldn't be a big row (its confirm step stays)
      {logout, _} = :binary.match(drawer, ~s(id="btn-logout"))
      {delete, _} = :binary.match(drawer, ~s(id="btn-delete"))
      assert logout < delete
      [legal] = Regex.run(~r/<p class="drawer-legal[^"]*">.*?<\/p>/s, drawer)
      assert legal =~ ~s(id="btn-delete")
    end
  end
end
