defmodule HoodrideWeb.AuthController do
  use HoodrideWeb, :controller
  require Logger

  alias Hoodride.{Accounts, Avatars}
  alias HoodrideWeb.Auth

  @google_auth "https://accounts.google.com/o/oauth2/v2/auth"
  @google_token "https://oauth2.googleapis.com/token"
  @google_userinfo "https://www.googleapis.com/oauth2/v3/userinfo"

  # Facebook: one Graph API version, pinned here (Meta retires old ones)
  @fb_graph "v25.0"
  @fb_auth "https://www.facebook.com/#{@fb_graph}/dialog/oauth"
  @fb_token "https://graph.facebook.com/#{@fb_graph}/oauth/access_token"
  @fb_me "https://graph.facebook.com/#{@fb_graph}/me"

  @providers ~w(google facebook)
  @auth_urls %{"google" => @google_auth, "facebook" => @fb_auth}
  # no email from either: nothing uses it (the narrowest scopes). Facebook's
  # PKCE lives in its OIDC manual flow, hence `openid`.
  @scopes %{"google" => "openid profile", "facebook" => "openid public_profile"}
  @labels %{"google" => "Google", "facebook" => "Facebook"}

  @doc """
  The sign-ins the login screen offers (PageController stamps them on the
  page): Google always; Facebook only once configured (its keys set). No
  dead button.
  """
  def providers do
    # Facebook only with its keys set — not for this machine's dev login
    # either: the owner dropped Facebook sign-in (2026-11-02)
    if client_id("facebook"), do: ["google", "facebook"], else: ["google"]
  end

  # GET /auth/:provider — kick off the OAuth dance
  # sobelow_skip ["XSS.SendResp"]
  def request(conn, %{"provider" => p} = params) when p in @providers do
    refreshing = params["refresh"] in ["1", "silent"] and conn.assigns[:current_user] != nil

    # (no address is blocked any more — one person on a café's Wi-Fi could
    # block sign-in there for an hour: the start budget per address and
    # the one-time state limit made-up codes instead; review 2026-11-14)
    cond do
      is_nil(client_id(p)) ->
        send_resp(conn, 503, not_configured(p))

      # Turnstile on: a start needs a passed check (POST /auth/start) — one
      # each; without, back to the sign-in screen, whose tap runs it. The
      # silent refresh of someone signed in is already known: none needed
      HoodrideWeb.Turnstile.on?() and not refreshing and not checked?(conn) ->
        redirect(conn, to: "/")

      # the providers asked us to wait (throttling): said now, not after a
      # trip to Google that would end the same way
      Hoodride.SignInFailures.paused?() ->
        busy(conn, refreshing, Hoodride.SignInFailures.wait_ms())

      true ->
        start(conn, p, refresh(conn, p, params["refresh"]))
    end
  end

  def request(conn, _), do: send_resp(conn, 404, "unknown provider")

  # POST /auth/start — {provider, token}: the app's Turnstile pass, checked
  # with Cloudflare (HoodrideWeb.Turnstile); passed, ONE sign-in start is
  # allowed for a minute, and the app goes there. Off: straight there.
  def checked_start(conn, %{"provider" => p} = params) when p in @providers do
    cond do
      not HoodrideWeb.Turnstile.on?() ->
        json(conn, %{go: "/auth/" <> p})

      HoodrideWeb.Turnstile.verify(params["token"], conn.remote_ip) == :ok ->
        conn
        |> put_session(
          :turnstile_ok,
          System.os_time(:second) + div(Hoodride.Limits.sign_in_check_ms(), 1000)
        )
        |> json(%{go: "/auth/" <> p})

      true ->
        conn |> put_status(403) |> json(%{error: "check_failed"})
    end
  end

  def checked_start(conn, _), do: conn |> put_status(404) |> json(%{error: "unknown_provider"})

  defp checked?(conn) do
    case get_session(conn, :turnstile_ok) do
      until when is_integer(until) -> until >= System.os_time(:second)
      _ -> false
    end
  end

  # back to the app with the refresh's outcome (googlerefresh.js shows it)
  defp back(conn, why), do: redirect(conn, to: "/?refresh=" <> why)

  # "Refresh from Google" (owner, 2026-10-29): Hood Ride keeps its own copy
  # of the name and photo, made at sign-in, so a changed Google profile
  # needs a Google round trip — no sign-out. `refresh=1` (the button) or
  # `silent` (the app on return: `prompt=none`, Google shows nothing; a
  # failure comes back still signed in). The hint is the account's Google
  # ID from the SERVER's session, never the request (Google: login_hint is
  # "either an email address or the sub string"). Not during a ride — the
  # page reload would interrupt it — and 5 per 10 minutes per account.
  # The database not answering: back to the app ("Couldn't refresh") —
  # it used to crash the request onto a bare error page.
  # → {mode | nil, extra params} | {:back, why}
  defp refresh(conn, "google", mode) when mode in ["1", "silent"] do
    with %{id: id} <- conn.assigns[:current_user],
         %Accounts.User{provider: "google", provider_id: sub} <- Accounts.profile(id) do
      cond do
        in_ride?(id) -> {:back, "ride"}
        not refresh_allowed?(id) -> {:back, "limit"}
        mode == "silent" -> {mode, %{login_hint: sub, prompt: "none"}}
        true -> {mode, %{login_hint: sub}}
      end
    else
      {:error, :unavailable} -> {:back, "failed"}
      _ -> {nil, %{}}
    end
  end

  defp refresh(_conn, _p, _mode), do: {nil, %{}}

  # a ride, or a request waiting on a driver (the app's "in a ride")
  defp in_ride?(user_id),
    do:
      Hoodride.Rides.ride_id_of_user(user_id) != nil or
        Hoodride.Requests.open_request_of(user_id) != nil

  defp refresh_allowed?(user_id) do
    case Hoodride.Limits.budget(:refresh_budget) do
      nil ->
        true

      l ->
        match?({:ok, _}, Hoodride.RateBudget.spend(user_id, :refresh, l[:per_minute], l[:burst]))
    end
  end

  # Google or Facebook can't be asked right now (they're throttling us, or
  # the used-state table is full): someone signed in goes back to the app;
  # anyone else gets a short page in their language, with Retry-After. The
  # session is left as it is — the same return works again after the wait
  # (its state was given back).
  # sobelow_skip ["XSS.SendResp"]
  defp busy(conn, refreshing, wait_ms) do
    conn = configure_session(conn, ignore: true)
    signed_in = conn.assigns[:current_user] != nil

    cond do
      signed_in and refreshing ->
        back(conn, "blocked")

      signed_in ->
        redirect(conn, to: "/")

      true ->
        lang = HoodrideWeb.Lang.pick(conn)

        conn
        |> HoodrideWeb.Lang.vary()
        |> put_resp_header("cache-control", "no-store")
        |> put_resp_header("retry-after", Integer.to_string(max(div(wait_ms + 999, 1000), 1)))
        |> put_resp_content_type("text/plain")
        |> send_resp(
          503,
          Hoodride.I18n.t(lang, "Sign-in is busy right now — try again in a moment.")
        )
    end
  end

  defp start(conn, _p, {:back, why}), do: back(conn, why)

  defp start(conn, p, {mode, extra}) do
    # anti login-CSRF: random state round-trips through the session
    state = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
    # PKCE (RFC 7636, S256): recommended for server apps too (RFC 9700 —
    # a stolen or injected code is useless without the verifier); Google's
    # discovery document lists S256, Facebook's OIDC flow supports it —
    # and DEFAULTS to "plain" unless the method is sent. Sent WITH the
    # client secret.
    verifier = Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

    params =
      %{
        client_id: client_id(p),
        redirect_uri: redirect_uri(conn, p),
        response_type: "code",
        scope: @scopes[p],
        state: state,
        code_challenge: Base.url_encode64(:crypto.hash(:sha256, verifier), padding: false),
        code_challenge_method: "S256"
      }
      |> Map.merge(extra)
      |> URI.encode_query()

    conn
    # a passed check allows one start: this one
    |> delete_session(:turnstile_ok)
    |> put_session(:oauth_state, state)
    |> put_session(:oauth_verifier, verifier)
    # which provider it's for, and when it started: a state is good once,
    # for 15 minutes, at its own provider's return (Hoodride.SignInStates)
    |> put_session(:oauth_provider, p)
    |> put_session(:oauth_at, System.os_time(:second))
    # a refresh's outcome is reported back to the app ("/?refresh=failed")
    |> put_session(:oauth_refresh, mode)
    |> redirect(external: @auth_urls[p] <> "?" <> params)
  end

  # GET /auth/:provider/callback — state-checked, then code → token → profile → session
  # sobelow_skip ["XSS.SendResp"]
  def callback(conn, %{"provider" => p, "code" => code, "state" => state}) when p in @providers do
    expected = get_session(conn, :oauth_state)
    verifier = get_session(conn, :oauth_verifier)
    refreshing = get_session(conn, :oauth_refresh) != nil
    issued = get_session(conn, :oauth_at)

    # the provider isn't asked anything without the state this browser was
    # given (RFC 6819 §4.4.1.12) — for THIS provider, under 15 minutes old.
    # Only TEXT: a crafted `state[]=x` or `code[]=x` used to crash the
    # request (server review, 2026-11-08)
    if is_binary(expected) and is_binary(verifier) and is_binary(state) and is_binary(code) and
         get_session(conn, :oauth_provider) == p and Hoodride.SignInStates.fresh?(issued) and
         Plug.Crypto.secure_compare(expected, state) do
      once(conn, p, code, state, issued, verifier, refreshing)
    else
      failed(
        forget_sign_in(conn),
        refreshing,
        403,
        "Sign-in session mismatch — go back and try again."
      )
    end
  end

  # no code: cancelled at Google, or a silent refresh Google couldn't do
  # (prompt=none: not signed into Google there, consent needed) — the app
  # is told, and whoever was signed in still is
  def callback(conn, _params) do
    refresh = get_session(conn, :oauth_refresh)
    conn = forget_sign_in(conn)
    if refresh, do: redirect(conn, to: "/?refresh=failed"), else: redirect(conn, to: "/")
  end

  # The state, used up ONCE (RFC 9700) before the provider is asked: the
  # session is a cookie the browser keeps, so a saved copy replayed the same
  # state — each time a call to Google (Hoodride.SignInStates). A repeat (a
  # double submit, a lost reply and a retry) goes home and leaves the
  # session alone: rewriting it could sign out the one that won.
  defp once(conn, p, code, state, issued, verifier, refreshing) do
    case Hoodride.SignInStates.consume(state, issued) do
      :used ->
        conn |> configure_session(ignore: true) |> redirect(to: "/")

      :full ->
        busy(conn, refreshing, 5_000)

      :ok ->
        if Hoodride.SignInFailures.paused?() do
          # the providers asked us to wait: not used after all
          Hoodride.SignInStates.give_back(state)
          busy(conn, refreshing, Hoodride.SignInFailures.wait_ms())
        else
          exchanged(forget_sign_in(conn), p, code, verifier, refreshing)
        end
    end
  end

  defp exchanged(conn, p, code, verifier, refreshing) do
    case exchange(conn, p, code, verifier, refresh_only(conn, refreshing)) do
      # a REFRESH completes only as the account signed in NOW (A2,
      # 2026-11-11): the hint is only a hint — at Google's picker someone
      # with two Google accounts can pick the other. Then no one is
      # signed in and no account is made or changed (exchange stops
      # before writing). Signed out everywhere meanwhile (another
      # device): no one — the refresh mustn't sign this browser back in
      :other_account when conn.assigns.current_user != nil ->
        back(conn, "other")

      :other_account ->
        redirect(conn, to: "/")

      # an ACCOUNT, nothing else: a provider's error reply also comes back
      # as {:ok, response} (Req), and was once signed in — a crash (500)
      # instead of the friendly page when Google was down
      {:ok, %Accounts.User{} = user} ->
        case Auth.sign_in(conn, user) do
          {:ok, conn} ->
            redirect(conn, to: "/")

          :error ->
            failed(
              conn,
              refreshing,
              503,
              "#{@labels[p]} sign-in failed — go back and try again."
            )
        end

      # our database couldn't save you: the same friendly page, not a raw error
      :db_failed ->
        failed(conn, refreshing, 503, "#{@labels[p]} sign-in failed — go back and try again.")

      # the provider refused THE CODE (made up, used, expired): counted
      # site-wide — watched, never blocking (Hoodride.SignInFailures)
      {:error, :rejected} ->
        Hoodride.SignInFailures.record()
        failed(conn, refreshing, 502, "#{@labels[p]} sign-in failed — go back and try again.")

      # the provider throttling us: its wait, or backoff (Google's rule)
      {:throttled, retry_ms} ->
        Hoodride.SignInFailures.throttled(p, retry_ms)
        busy(conn, refreshing, Hoodride.SignInFailures.wait_ms())

      # OUR request refused (a wrong secret, a changed redirect…): never
      # counted against anyone — the owner must look (deploy/errors.sh)
      {:setup, status, error} ->
        Logger.error(
          "sign-in: #{p} refused our request (#{status} #{error}) — " <>
            "check its keys and settings (GOOGLE_SETUP.md)"
        )

        failed(conn, refreshing, 502, "#{@labels[p]} sign-in failed — go back and try again.")

      _ ->
        failed(conn, refreshing, 502, "#{@labels[p]} sign-in failed — go back and try again.")
    end
  end

  # A sign-in that didn't work. Someone still signed in goes back to the app
  # — "Couldn't refresh" when it was a refresh — never to a bare page
  # outside it: the silent refresh runs on its own when the app comes back
  # to the front, and a second tab refreshing at the same moment replaces
  # the first one's state (server review, 2026-11-08). Anyone else: the page.
  # sobelow_skip ["XSS.SendResp"]
  defp failed(conn, refreshing, status, text) do
    signed_in = conn.assigns[:current_user] != nil

    cond do
      signed_in and refreshing -> back(conn, "failed")
      signed_in -> redirect(conn, to: "/")
      true -> send_resp(conn, status, text)
    end
  end

  defp forget_sign_in(conn) do
    conn
    |> delete_session(:oauth_state)
    |> delete_session(:oauth_verifier)
    |> delete_session(:oauth_refresh)
    |> delete_session(:oauth_provider)
    |> delete_session(:oauth_at)
  end

  # The token endpoint's answer (review 2026-11-14 — only a refused CODE
  # counts; anything else said what it is):
  #   * a token (TEXT only: anything else crashed the next request);
  #   * THE CODE refused — Google's `invalid_grant` (RFC 6749 §5.2), and
  #     Facebook's code 100 (it never says invalid_grant): {:error, :rejected};
  #   * throttling — a 429, Facebook's 4, 17, 32, 613: {:throttled, ms | nil};
  #   * any other 4xx: OUR request refused (a wrong secret, a changed
  #     redirect address) — {:setup, status, error};
  #   * anything else (the provider down, a network error): as it is.
  defp token(_p, {:ok, %{status: 200, body: %{"access_token" => token}}}) when is_binary(token) do
    Hoodride.SignInFailures.answered()
    {:token, token}
  end

  defp token(_p, {:ok, %{status: 200}} = malformed), do: malformed
  defp token(_p, {:ok, %{status: 429} = r}), do: {:throttled, retry_after_ms(r)}

  defp token("google", {:ok, %{status: 400, body: %{"error" => "invalid_grant"}}}),
    do: {:error, :rejected}

  defp token("facebook", {:ok, %{status: 400, body: %{"error" => %{"code" => 100}}}}),
    do: {:error, :rejected}

  defp token("facebook", {:ok, %{body: %{"error" => %{"code" => c}}} = r})
       when c in [4, 17, 32, 613],
       do: {:throttled, retry_after_ms(r)}

  defp token(_p, {:ok, %{status: status, body: body}}) when status in 400..499,
    do: {:setup, status, error_word(body)}

  defp token(_p, other), do: other

  # the provider's Retry-After (seconds), as ms — or nil
  defp retry_after_ms(r) do
    with [v | _] <- Req.Response.get_header(r, "retry-after"),
         {s, ""} when s >= 0 and s <= 3600 <- Integer.parse(String.trim(v)) do
      s * 1000
    else
      _ -> nil
    end
  end

  # the provider's error, as one plain word for the log (never its text)
  defp error_word(%{"error" => e}) when is_binary(e), do: safe_word(e)
  defp error_word(%{"error" => %{"code" => c}}) when is_integer(c), do: "code #{c}"
  defp error_word(_), do: "?"

  defp safe_word(e),
    do: if(Regex.match?(~r/\A[a-z_]{1,40}\z/, e), do: e, else: "?")

  # only the database being unable to answer is caught; any other error (a
  # bug) still crashes visibly
  defp exchange(conn, p, code, verifier, only) do
    exchange_code(conn, p, code, verifier, only)
  rescue
    e -> if Hoodride.Repo.down?(e), do: :db_failed, else: reraise(e, __STACKTRACE__)
  end

  # A refresh: the Google ID it must come back as — the account signed in
  # NOW (another tab may have changed it since the refresh left), :nobody
  # when signed out meanwhile or no longer a Google account, :unavailable
  # when the database can't say. nil: an ordinary sign-in, any account.
  defp refresh_only(_conn, false), do: nil

  defp refresh_only(conn, true) do
    with %{id: id} <- conn.assigns[:current_user],
         %Accounts.User{provider: "google", provider_id: sub} <- Accounts.profile(id) do
      sub
    else
      {:error, :unavailable} -> :unavailable
      _ -> :nobody
    end
  end

  # checked BEFORE anything is written: a refresh never makes or changes
  # another account
  defp same_account(nil, _sub), do: :ok
  defp same_account(sub, sub), do: :ok
  defp same_account(:unavailable, _sub), do: :db_failed
  defp same_account(_only, _sub), do: :other_account

  defp exchange_code(conn, "google", code, verifier, only) do
    with {:token, token} <-
           token(
             "google",
             Req.post(
               @google_token,
               [
                 form: [
                   code: code,
                   client_id: client_id("google"),
                   client_secret: client_secret("google"),
                   redirect_uri: redirect_uri(conn, "google"),
                   grant_type: "authorization_code",
                   code_verifier: verifier
                 ]
               ] ++ req_options("google")
             )
           ),
         # an account ID that is TEXT, in a profile that is a map: anything
         # else used to crash (Ecto refuses a nil comparison)
         {:ok, %{status: 200, body: %{"sub" => sub} = info}} when is_binary(sub) <-
           Req.get(@google_userinfo, [auth: {:bearer, token}] ++ req_options("google")),
         :ok <- same_account(only, sub) do
      old = Accounts.photo_of("google", sub)
      # our own small copy, made now (Hoodride.Avatars) — viewers never
      # ask Google, and the link can't rot
      new = Avatars.from_google(info["picture"], old)

      Avatars.keep_if_saved(new, old, fn ->
        Accounts.upsert_oauth_user(%{
          provider: "google",
          provider_id: sub,
          # strangers see a first name only (Accounts.first_name/2) — never
          # the email
          name: Accounts.first_name(info["given_name"], info["name"]),
          photo: new
        })
      end)
    end
  end

  # (a refresh is Google only: a refresh's state brought HERE — a state isn't
  # tied to its provider — is never a match, nothing written: it crashed on
  # `only` before (review, 2026-11-11))
  defp exchange_code(conn, "facebook", code, verifier, only) do
    with {:token, token} <-
           token(
             "facebook",
             Req.post(
               @fb_token,
               [
                 form: [
                   code: code,
                   client_id: client_id("facebook"),
                   client_secret: client_secret("facebook"),
                   redirect_uri: redirect_uri(conn, "facebook"),
                   code_verifier: verifier
                 ]
               ] ++ req_options("facebook")
             )
           ),
         {:ok, %{status: 200, body: %{"id" => id} = info}} when is_binary(id) <-
           Req.get(
             @fb_me,
             [params: [fields: "id,first_name"], auth: {:bearer, token}] ++
               req_options("facebook")
           ),
         :ok <- if(only == nil, do: :ok, else: :other_account) do
      old = Accounts.photo_of("facebook", id)
      # our own small copy, made now with the user's own token
      # (Hoodride.Avatars): Facebook's tokenless picture address gives a
      # SILHOUETTE to apps in Development mode, and its photo URLs expire
      new =
        Avatars.from_facebook(token, old, "https://graph.facebook.com/#{@fb_graph}/me/picture")

      Avatars.keep_if_saved(new, old, fn ->
        Accounts.upsert_oauth_user(%{
          provider: "facebook",
          # app-scoped: unique to Hood Ride, useless to other apps
          provider_id: id,
          name: Accounts.first_name(info["first_name"], nil),
          photo: new
        })
      end)
    end
  end

  defp not_configured("google"),
    do:
      "Google OAuth isn't configured yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — see GOOGLE_SETUP.md in the project root."

  defp not_configured("facebook"),
    do:
      "Facebook sign-in isn't configured yet. Set FACEBOOK_APP_ID and FACEBOOK_APP_SECRET — see GOOGLE_SETUP.md in the project root."

  # GET /api/me — who am I (session-based)
  def me(conn, _params) do
    case conn.assigns.current_user do
      nil ->
        json(conn, %{user: nil})

      u ->
        json(conn, %{
          user: %{id: u.id, name: u.name, photo: u.photo, provider: u.provider}
        })
    end
  end

  # POST /api/dev_login — dev-only: mock buttons create real sessions,
  # so two browser windows can be two real users before OAuth is configured.
  # It signs in BY NAME, so only a genuinely local request may use it: a
  # tunnel (ngrok, Cloudflare) forwards from 127.0.0.1, so the address alone
  # isn't enough — the host must be local and no forwarding header present.
  def dev_login(conn, params) do
    if Application.get_env(:hoodride, :dev_login, false) and local_request?(conn) do
      name = params["name"] || "Test User"
      photo = params["photo"]

      # text only, and small: the name and photo go into the session cookie
      # (4 KB). Anything else used to crash halfway — after the account was
      # written (server review, 2026-11-08)
      if dev_name?(name) and dev_photo?(photo),
        do: dev_sign_in(conn, name, photo, params["agree_terms"] == true),
        else: conn |> put_status(400) |> json(%{error: "invalid"})
    else
      send_resp(conn, 404, "not found")
    end
  end

  # (a blank name is refused by the account's own changeset: name required)
  defp dev_name?(name), do: is_binary(name) and String.length(name) <= 60

  defp dev_photo?(photo), do: is_nil(photo) or (is_binary(photo) and byte_size(photo) <= 2_000)

  # the load and test scripts (test_load/*.mjs) skip the Terms screen: they
  # say {"agree_terms": true}. The browser journeys tap the real button.
  defp dev_sign_in(conn, name, photo, agree?) do
    attrs = %{provider: "dev", provider_id: name, name: name, photo: photo}

    with {:ok, user} <- Accounts.upsert_oauth_user(attrs),
         :ok <- if(agree?, do: Accounts.agree_to_terms(user.id), else: :ok),
         %Accounts.User{} = user <- Accounts.profile(user.id),
         {:ok, conn} <- Auth.sign_in(conn, user) do
      json(conn, %{ok: true})
    else
      {:error, %Ecto.Changeset{}} -> conn |> put_status(400) |> json(%{error: "invalid"})
      _ -> conn |> put_status(503) |> json(%{error: "unavailable"})
    end
  rescue
    e ->
      if Hoodride.Repo.down?(e),
        do: conn |> put_status(503) |> json(%{error: "unavailable"}),
        else: reraise(e, __STACKTRACE__)
  end

  @loopback [{127, 0, 0, 1}, {0, 0, 0, 0, 0, 0, 0, 1}]
  @local_hosts ["localhost", "127.0.0.1", "[::1]", "::1"]
  @forwarding ["x-forwarded-for", "forwarded", "x-real-ip", "x-forwarded-host"]

  defp local_request?(conn) do
    conn.remote_ip in @loopback and conn.host in @local_hosts and
      Enum.all?(@forwarding, &(get_req_header(conn, &1) == []))
  end

  # (There is deliberately NO profile lookup by id. GET /api/users/:id used
  # to answer any id for any logged-in user — loop the ids, collect every
  # name and photo. A hand's owner is now named only by the WorldChannel's
  # `reveal`, for a driver who can see that hand.)

  # any other /api/ path: a JSON 404, never the app page the catch-all
  # route would serve
  def not_found(conn, _params), do: conn |> put_status(404) |> json(%{error: "not_found"})

  # GET /api/state — full rehydration: reopen the app, get your life back.
  # Server memory is the truth; the client is a mirror. Everyone it mentions
  # (ride partner, chat partners, requests) is looked up in ONE query — it
  # used to be one per person, on every app open and every reconnect. If
  # the database can't answer: 503, which the app retries (HoodBoot), never
  # a state with people missing.
  #
  # Light reload (owner, 2026-11-08): `chats=list` (exactly) — each chat as
  # a summary (Hoodride.Chat.summary/2: no texts), and `open_peer=<id>` the
  # one chat on screen in full, so a reconnect keeps its place. Without it:
  # every chat in full, as before (older app copies).
  def state(conn, params) do
    # the app is in use: a week-old sign-in is replaced, the cookie renewed.
    # Never stored by a browser or a proxy (chats, a ride, who you are).
    conn = conn |> Auth.keep_signed_in() |> put_resp_header("cache-control", "no-store")

    with %{} = u <- conn.assigns.current_user,
         # a ride too busy to answer: retried like a busy database, never
         # "no ride" (the app would close it: Hoodride.RideBusyTest)
         ride when ride != :busy <- ride_of(u.id) do
      convos = Hoodride.Chat.conversations_for(u.id)
      open = Hoodride.Requests.open_request_of(u.id)
      pending = Hoodride.Requests.pending_for_driver(u.id)

      ids =
        Enum.map(convos, & &1.peer_id) ++
          Enum.map(pending, & &1.rider_id) ++
          Enum.reject([ride && elem(ride, 1), open && open.driver_id], &is_nil/1)

      {conn, terms_agreed} = terms_agreed(conn, u)

      case Accounts.profiles(ids) do
        {:ok, people} ->
          json(conn, %{
            user: %{id: u.id, name: u.name, photo: u.photo, provider: u.provider},
            # not yet agreed to the current Terms of Use: the app asks first
            # (and gets no connection token until then)
            terms_agreed: terms_agreed,
            ride: ride_state(ride, u.id, people),
            conversations: conversation_state(convos, people, chats_wanted(params), u.id),
            open_request: open_request_state(open, people),
            pending_requests: pending_request_state(pending, people),
            # live map presence, so a reload RESUMES a raised hand or an
            # on-duty shift instead of orphaning the row as a ghost
            hand: Hoodride.Geo.hand_of(u.id),
            on_map: Hoodride.Geo.driver_on_map?(u.id),
            # the server's clock (ms): message times are on it, and a phone's
            # clock can be off — the chat list's "2m ago" corrects for it
            now: System.system_time(:millisecond)
          })

        {:error, :unavailable} ->
          conn |> put_status(503) |> json(%{error: "busy"})
      end
    else
      :busy -> conn |> put_status(503) |> json(%{error: "busy"})
      _ -> json(conn, %{user: nil})
    end
  end

  # the session says whether this device has agreed; if it says no, the
  # account may have agreed on another device since — then this session
  # learns it (one read, only while not agreed), and isn't asked again
  defp terms_agreed(conn, u) do
    cond do
      Hoodride.Terms.agreed?(u) ->
        {conn, true}

      Hoodride.Terms.agreed?(account_terms(u.id)) ->
        {put_session(conn, :terms_version, Hoodride.Terms.version()), true}

      true ->
        {conn, false}
    end
  end

  # (the database busy: "not agreed" for now — agreeing again is harmless)
  defp account_terms(user_id) do
    Accounts.get_user(user_id) || %{}
  rescue
    e -> if Hoodride.Repo.down?(e), do: %{}, else: reraise(e, __STACKTRACE__)
  end

  defp person(%{id: id, name: name, photo: photo}), do: %{id: id, name: name, photo: photo}

  # a driver, as their rider sees them: with their car (ARCHITECTURE.md
  # "Your car"; nil when none is set)
  defp driver_person(d),
    do:
      person(d)
      |> Map.put(:car, Accounts.car_label(d))
      |> Map.put(:car_parts, Accounts.car_parts(d))

  # {ride state, partner id}, nil, or :busy (alive but slow to answer)
  defp ride_of(user_id) do
    with ride_id when not is_nil(ride_id) <- Hoodride.Rides.ride_id_of_user(user_id),
         {:ok, st} <- Hoodride.Rides.get(ride_id) do
      {st, if(st.rider == user_id, do: st.driver, else: st.rider)}
    else
      {:error, :busy} -> :busy
      _ -> nil
    end
  end

  defp ride_state(nil, _user_id, _people), do: nil

  defp ride_state({st, peer_id}, user_id, people) do
    with %{} = peer <- people[peer_id] do
      %{
        id: st.id,
        role: if(st.rider == user_id, do: "rider", else: "driver"),
        pin: st.pin,
        arrived: st.arrived,
        # a rider's partner is the driver: with their car
        peer: if(st.rider == user_id, do: driver_person(peer), else: person(peer))
      }
    end
  end

  # :full (as before), or {:list, the open chat's partner id as text | nil}.
  # Only the exact text: a list or a map (chats[]=…) is the full answer.
  defp chats_wanted(%{"chats" => "list"} = params) do
    {:list, if(is_binary(params["open_peer"]), do: params["open_peer"])}
  end

  defp chats_wanted(_params), do: :full

  # a summary, unless it's the full answer or the chat on screen
  defp summary?(:full, _peer_id), do: false
  defp summary?({:list, open}, peer_id), do: open != Integer.to_string(peer_id)

  defp conversation_state(convos, people, wanted, user_id) do
    for c <- convos, peer = people[c.peer_id], peer != nil do
      # the partner's latest block, if they shared one (not driving) — with
      # its age on the server's clock (ARCHITECTURE.md "Distances")
      base = %{peer: person(peer), last_activity: c.last_activity, peer_spot: c.peer_spot}

      if summary?(wanted, c.peer_id) do
        s = Hoodride.Chat.summary(c, user_id)
        Map.merge(base, %{last: s.last, theirs: s.theirs})
      else
        Map.put(base, :messages, c.messages)
      end
    end
  end

  # GET /api/chat?peer=<id> — one chat's messages, when it's opened (light
  # reload). Signed out: 401; the Terms not yet agreed: 403, read from the
  # session as socket_token (no database read here at all). Anything that
  # isn't the caller's chat now: the same 404 "none" (nothing told about
  # anyone else's). Not kept signed in from here (a reload or a reconnect
  # does that). Its own budget (the :chat_api pipeline).
  def chat(conn, params) do
    conn = put_resp_header(conn, "cache-control", "no-store")

    case conn.assigns.current_user do
      nil ->
        conn |> put_status(401) |> json(%{error: "unauthenticated"})

      user ->
        cond do
          not Hoodride.Terms.agreed?(user) ->
            conn |> put_status(403) |> json(%{error: "terms"})

          true ->
            case Hoodride.Chat.conversation_messages(user.id, params["peer"]) do
              {:ok, messages} -> json(conn, %{messages: messages})
              :none -> conn |> put_status(404) |> json(%{error: "none"})
            end
        end
    end
  end

  defp open_request_state(nil, _people), do: nil

  defp open_request_state(r, people) do
    with %{} = d <- people[r.driver_id], do: %{driver: driver_person(d), ts: r.ts}
  end

  defp pending_request_state(pending, people) do
    for r <- pending, rd = people[r.rider_id], rd != nil do
      %{rider: person(rd), ts: r.ts, spot: r.spot}
    end
  end

  # GET /api/socket_token — signed token for websocket auth (session required)
  def socket_token(conn, _params) do
    # an app kept open for days reconnects through here, not /api/state:
    # it stays signed in too (the pass then names the new sign-in)
    conn = Auth.keep_signed_in(conn)

    case conn.assigns.current_user do
      nil ->
        conn |> put_status(401) |> json(%{error: "unauthenticated"})

      # the Terms of Use first (Hoodride.Terms): no map, rides or chats
      # before. (Read from the session: no database read here.)
      user ->
        if Hoodride.Terms.agreed?(user),
          # the build too: a tab whose socket can't connect (it fetches a
          # fresh token after a failed connect) still learns a new version
          do: json(conn, %{token: Auth.socket_token(user), build: HoodrideWeb.Build.current()}),
          else: conn |> put_status(403) |> json(%{error: "terms"})
    end
  end

  # POST /api/terms/accept — the one-time "I agree" (clickwrap):
  # when and which version saved on the account (the proof), and in this
  # session (the token check above). If the database can't: 503, nothing
  # saved, the app says "try again".
  def accept_terms(conn, _params) do
    with %{} = u <- conn.assigns.current_user,
         :ok <- Accounts.agree_to_terms(u.id) do
      conn |> put_session(:terms_version, Hoodride.Terms.version()) |> json(%{ok: true})
    else
      nil -> conn |> put_status(401) |> json(%{error: "unauthenticated"})
      {:error, :unavailable} -> conn |> put_status(503) |> json(%{error: "failed"})
    end
  end

  # POST /api/logout — signs the account out EVERYWHERE: every older session
  # and socket token is refused from now on (HoodrideWeb.Auth), the account
  # goes off the map at once (car and ✋ — not left up for the sweeper's
  # ~5 min grace), and every open socket of the account is closed now (not
  # just this tab's). 409 during a ride or while your own request waits,
  # the same rule as deleting the account: the app's button is only the
  # first guard (another tab, an old app, a tap racing an accept).
  def logout(conn, _params) do
    user = conn.assigns.current_user

    case user && logout_refusal(user.id) do
      nil -> do_logout(conn, user)
      reason -> conn |> put_status(409) |> json(%{error: reason})
    end
  end

  defp logout_refusal(user_id) do
    cond do
      Hoodride.Rides.ride_id_of_user(user_id) != nil -> :in_ride
      Hoodride.Requests.open_request_of(user_id) != nil -> :request_waiting
      true -> nil
    end
  end

  defp do_logout(conn, user) do
    case user && Accounts.mark_logged_out(user.id) do
      # the database couldn't: NOTHING changed (still signed in everywhere,
      # still on the map), and the app says "couldn't sign out — try again"
      {:error, :failed} ->
        conn |> put_status(503) |> json(%{error: "failed"})

      result ->
        if result == :ok do
          # signed out — THEN a ride or request that slipped past the check
          # above meanwhile is ended/withdrawn (A1: the partner never waits
          # on someone signed out; the other side looks too)
          Hoodride.Rides.after_sign_out(user.id)
          # off the map; going offline also declines every incoming
          # request, each rider told (as AccountDeletion does). A live
          # connection can't put anything back meanwhile: its sign-in is
          # already gone, and every action checks it (HoodrideWeb.UserChannel)
          Hoodride.Geo.driver_offline(user.id)
          Hoodride.Geo.hand_down(user.id)
          HoodrideWeb.Endpoint.broadcast("user_socket:#{user.id}", "disconnect", %{})
        end

        conn |> configure_session(drop: true) |> json(%{ok: true})
    end
  end

  # POST /api/account/delete — {confirm: "DELETE"}: the word the person
  # typed (any case; owner, 2026-11-04), not just `true` — an old or broken
  # copy of the app can't skip typing it. Deletes the account and all it
  # left behind (Hoodride.AccountDeletion), then ends this session. 409
  # during a ride or while your own request waits (end/cancel it first).
  def delete_account(conn, _params) do
    cond do
      conn.assigns.current_user == nil ->
        conn |> put_status(401) |> json(%{error: "unauthenticated"})

      # JSON only, and the word only from it — never the address
      # (`?confirm=DELETE` used to count, whatever the body)
      not HoodrideWeb.JsonBody.json?(conn) ->
        HoodrideWeb.JsonBody.refuse(conn)

      not typed_delete?(HoodrideWeb.JsonBody.object(conn)["confirm"]) ->
        conn |> put_status(400) |> json(%{error: "confirm"})

      true ->
        case Hoodride.AccountDeletion.delete(conn.assigns.current_user.id) do
          :ok ->
            conn |> configure_session(drop: true) |> json(%{ok: true})

          # the database couldn't: nothing was deleted, try again
          {:error, :failed} ->
            conn |> put_status(503) |> json(%{error: "failed"})

          {:error, reason} ->
            conn |> put_status(409) |> json(%{error: Atom.to_string(reason)})
        end
    end
  end

  # DELETE, or the word in any language the app knows (the screen asks for
  # the reader's: "ELIMINAR") — whatever language the page was in
  defp typed_delete?(word) when is_binary(word),
    do: Hoodride.I18n.typed_word(word) in Hoodride.I18n.delete_words()

  defp typed_delete?(_), do: false

  defp client_id("google"), do: key(:google_client_id, "GOOGLE_CLIENT_ID")
  defp client_id("facebook"), do: key(:facebook_app_id, "FACEBOOK_APP_ID")
  defp client_secret("google"), do: key(:google_client_secret, "GOOGLE_CLIENT_SECRET")
  defp client_secret("facebook"), do: key(:facebook_app_secret, "FACEBOOK_APP_SECRET")

  # a blank value is no key: /etc/hoodride/env keeps `FACEBOOK_APP_ID=` until
  # the keys come, and "" counted as set — a live button to a broken sign-in
  # (deploy day, 2026-10-28)
  defp key(config, env) do
    Enum.find_value([Application.get_env(:hoodride, config), System.get_env(env)], fn
      v when is_binary(v) -> if String.trim(v) != "", do: v
      _ -> nil
    end)
  end

  # extra Req options (tests stub each provider with Req.Test)
  defp req_options("google"), do: Application.get_env(:hoodride, :google_req, [])
  defp req_options("facebook"), do: Application.get_env(:hoodride, :facebook_req, [])

  # prod: the configured public URL (behind an HTTPS proxy the request says
  # http://…:4000); dev/test: the request's own host, so phone-on-LAN works
  defp redirect_uri(conn, p) do
    if Application.get_env(:hoodride, :oauth_redirect_from_request, false),
      do: "#{conn.scheme}://#{conn.host}:#{conn.port}/auth/#{p}/callback",
      else: HoodrideWeb.Endpoint.url() <> "/auth/#{p}/callback"
  end
end
