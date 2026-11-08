defmodule HoodrideWeb.TermsTest do
  @moduledoc """
  The Terms of Use (owner, 2026-10-31): a public page at /terms, and a
  one-time "I agree" before the map (clickwrap — the kind courts
  enforce most reliably). The server is the truth: until you've agreed to
  the CURRENT version (Hoodride.Terms.version/0, the page's effective date)
  it gives the app no connection token. The agreement — when, and which
  version — is kept on the account (the proof), and in the signed session
  cookie so the token check reads no database. A new version asks again.
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Repo, Terms}

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  # signed in the way the app is: Auth.sign_in (the session carries what
  # the account has agreed to)
  defp signed_in(u) do
    {:ok, conn} =
      build_conn()
      |> init_test_session(%{})
      |> HoodrideWeb.Auth.sign_in(Accounts.get_user(u.id))

    conn
  end

  defp agree(conn), do: post(conn, "/api/terms/accept")

  describe "the page" do
    test "is public, and says the key things", %{conn: conn} do
      html = conn |> get("/terms") |> html_response(200)

      for must <- [
            "Terms of Use",
            "Effective #{Terms.effective_text()}",
            "You must be 18 or older. One account per person.",
            "not a party to it",
            "We don't check anyone",
            "Hood Ride never handles, sets or takes any payment. Any arrangement between a rider and a driver is solely between them, and at their own risk.",
            "provides no insurance",
            "call your local emergency number (911 in the US)",
            "never rely on them in an emergency",
            # 2026-11-02 (owner): who it connects, as the app works — anyone
            # nearby, not only next door (the disclaimer around it unchanged)
            "Hood Ride helps people nearby find each other for rides, and nothing more. We are not a taxi, transportation or ride-hailing company. We don't provide rides, employ drivers, or take part in any ride. Each ride is an arrangement solely between the rider and the driver; Hood Ride is not a party to it.",
            # …and no shortened deadline: the law's own (as Uber's terms);
            # one year is void in some states (Texas: under 2 years; Florida)
            "Any claim between you and Hood Ride must be brought within the time the applicable law allows.",
            # what others see: a pointer to the privacy policy's "Who sees
            # what", not a second list that can drift from it (it said
            # "rough location" only; a ride shares the exact one) — as
            # Uber's terms point to its Privacy Notice (owner, 2026-11-02)
            ~s(Other users see some of what you share, such as your name, photo and rough location; our <a href="/privacy">Privacy Policy</a> explains exactly who sees what. We're not responsible for what other users do with anything you share with them.),
            # the indemnity names breaking the terms too, as Uber's does —
            # still only your own doing, reasonable fees (owner, 2026-11-02)
            "If your use of Hood Ride, your ride, your conduct, or your breaking these terms leads to a claim against Hood Ride or its operator, you agree to cover the costs, including reasonable legal fees.",
            "contact@hoodride.app",
            ~s(href="/privacy")
          ],
          do: assert(html =~ must, "missing: #{must}")

      for gone <- ["helps neighbors find each other", "within one year", "permanently barred"],
          do: refute(html =~ gone, "still there: #{gone}")

      # that wording is a new version: everyone is asked again
      assert Terms.version() >= "2026-11-02"
    end

    # conspicuous: courts look for it (owner, 2026-10-31)
    test "the limit of responsibility is in bold, $100", %{conn: conn} do
      html = conn |> get("/terms") |> html_response(200)

      [section] =
        Regex.run(~r{<h2[^>]*>13\. Limit of our responsibility</h2>\s*<p>(.*?)</p>}s, html,
          capture: :all_but_first
        )

      assert section =~ ~r/^<strong>To the fullest extent the law allows/
      assert section =~ "limited to $100"
      assert section =~ ~r{</strong>$}
    end

    # payments left open (owner, 2026-10-31): the no-profit rule is parked
    # in ARCHITECTURE.md ("Terms of Use"), word for word, to bring back as a
    # new version — neither the page nor the screen sets a money rule
    test "no money rule: the page and the screen say nothing about profit", %{conn: conn} do
      refute conn |> get("/terms") |> html_response(200) =~ ~r/profit/i

      [screen] =
        Regex.run(
          ~r{<section id="screen-terms".*?</section>}s,
          File.read!("priv/static/index.html")
        )

      refute screen =~ ~r/profit|cost/i
    end

    # open to anyone, anywhere (owner, 2026-10-31): no page limits who can
    # use Hood Ride to the US (the privacy page still says where it's RUN)
    test "no page limits users to the United States", %{conn: conn} do
      for page <- ["/terms", "/privacy", "/"] do
        html = conn |> get(page) |> html_response(200)
        refute html =~ ~r/(must|only)[^.<]*(United States|\bUS\b|\bU\.S\.)/i, page
        refute html =~ ~r/18 or older and in/i, page
      end
    end

    # no state named (owner's choice, 2026-10-31), and no placeholder left
    test "nothing left to fill in, and no governing-law section", %{conn: conn} do
      html = conn |> get("/terms") |> html_response(200)
      refute html =~ ~r/\[[^\]]*\]/
      refute html =~ ~r/governed by the laws/i
    end

    test "the version is the page's effective date (change one, change both)" do
      html = File.read!("priv/static/terms.html")

      [date] =
        Regex.run(~r/Effective ([A-Z][a-z]+ \d{1,2}, \d{4})/, html, capture: :all_but_first)

      assert date == Terms.effective_text()
      assert Date.from_iso8601!(Terms.version()) |> Calendar.strftime("%B %-d, %Y") == date
    end

    # the screen is minimal (owner, 2026-10-31): a line, the two links, the
    # button — the rules themselves (18+ among them) are in the Terms
    test "the 'Before you start' screen: one line, both links, I agree — nothing else" do
      [screen] =
        Regex.run(
          ~r{<section id="screen-terms".*?</section>}s,
          File.read!("priv/static/index.html")
        )

      # the car above it, smaller than on the sign-in screen (owner, 2026-10-31)
      assert screen =~ ~s(<img class="terms-car" src="car.png" alt="" />
      <h1 data-t>Before you start</h1>)
      css = File.read!("priv/static/styles.css")
      assert css =~ ~r/\.terms-car \{[^}]*width: 120px;/
      # as tight under the car as the sign-in screen's name (-2 px, line 1.1)
      assert css =~ ~r/\.terms-car \{[^}]*margin: 0 auto -20px;/
      assert css =~ ~r/\.terms-card h1 \{[^}]*line-height: 1\.1;/

      # ("Privacy Policy" never split, and the line balanced: "Policy." sat
      # alone on a line of its own on a phone — owner, 2026-10-31)
      assert screen =~
               ~s(<p class="terms-line" data-t>Please read and agree to our <a href="/terms" data-t data-t-slot="terms">Terms</a> and <a href="/privacy" data-t data-t-slot="privacy">Privacy&nbsp;Policy</a>.</p>)

      assert File.read!("priv/static/styles.css") =~ ~r/\.terms-line \{[^}]*text-wrap: balance;/

      assert screen =~ ~s(<button id="btn-agree" class="btn btn-primary" data-t>I agree</button>)
      refute screen =~ "<li>"
      refute screen =~ ~r/18|911/
    end

    test "linked from the sign-in screen (the agreement line), the drawer and the privacy page",
         %{conn: conn} do
      index = File.read!("priv/static/index.html")
      [line] = Regex.run(~r{<p class="fineprint" data-t>.*?</p>}s, index)
      assert line =~ ~s(<a href="/terms" data-t data-t-slot="terms">Terms</a>)
      assert line =~ ~s(<a href="/privacy" data-t data-t-slot="privacy">Privacy Policy</a>)
      [drawer] = Regex.run(~r{<p class="drawer-legal muted">.*?</p>}s, index)
      assert drawer =~ ~s(href="/terms")
      assert conn |> get("/privacy") |> html_response(200) =~ ~s(href="/terms")
    end
  end

  describe "agreeing" do
    test "a new account hasn't agreed: the app is told, and gets no connection token" do
      conn = signed_in(user("tm-new"))
      assert json_response(get(conn, "/api/state"), 200)["terms_agreed"] == false
      assert json_response(get(conn, "/api/socket_token"), 403) == %{"error" => "terms"}
    end

    test "agreeing saves when and which version, and then the app connects" do
      u = user("tm-agree")
      before = System.system_time(:millisecond)
      conn = agree(signed_in(u))
      assert json_response(conn, 200) == %{"ok" => true}

      saved = Accounts.get_user(u.id)
      assert saved.terms_version == Terms.version()
      assert saved.terms_accepted_at >= before

      # the same browser, from now on (the session cookie carries it)
      next = recycle(conn)
      assert json_response(get(next, "/api/state"), 200)["terms_agreed"] == true
      assert %{"token" => _} = json_response(get(next, "/api/socket_token"), 200)
    end

    test "signing in again on another device: already agreed" do
      u = user("tm-again")
      agree(signed_in(u))
      assert %{"token" => _} = json_response(get(signed_in(u), "/api/socket_token"), 200)
    end

    test "agreed on another device while this one was signed in: not asked again here" do
      u = user("tm-other")
      laptop = signed_in(u)
      agree(signed_in(u))

      # the laptop's session is from before: the account says it agreed
      state = get(laptop, "/api/state")
      assert json_response(state, 200)["terms_agreed"] == true
      assert %{"token" => _} = json_response(get(recycle(state), "/api/socket_token"), 200)
    end

    test "a new version asks again" do
      u = user("tm-old")
      agree(signed_in(u))
      Repo.query!("UPDATE users SET terms_version = '2026-01-01' WHERE id = ?", [u.id])

      conn = signed_in(u)
      assert json_response(get(conn, "/api/state"), 200)["terms_agreed"] == false
      assert json_response(get(conn, "/api/socket_token"), 403) == %{"error" => "terms"}
    end

    test "signed out: refused", %{conn: conn} do
      assert json_response(agree(conn), 401) == %{"error" => "unauthenticated"}
    end

    test "the database can't answer: not agreed, try again" do
      u = user("tm-db")
      conn = signed_in(u)
      Repo.query!("ALTER TABLE users RENAME TO users_away")

      try do
        assert json_response(agree(conn), 503) == %{"error" => "failed"}
      after
        Repo.query!("ALTER TABLE users_away RENAME TO users")
      end

      assert Accounts.get_user(u.id).terms_version == nil
    end

    test "without agreeing you can still sign out and delete your account" do
      assert json_response(post(signed_in(user("tm-out")), "/api/logout"), 200) == %{"ok" => true}

      u = user("tm-del")

      assert json_response(
               post(signed_in(u), "/api/account/delete", %{"confirm" => "DELETE"}),
               200
             ) ==
               %{"ok" => true}

      assert Accounts.get_user(u.id) == nil
    end
  end
end
