defmodule HoodrideWeb.Auth do
  @moduledoc """
  Who is signed in — decided on the SERVER, the same way for every path
  (HTTP, a socket token in the header or the URL, a socket session).

  Phoenix's own sign-in design (phx.gen.auth session tokens, 2026-11-08;
  Hoodride.SessionTokens): the session cookie holds a random token, valid
  while its row exists — 30 days, replaced weekly while the app is in use,
  a year at most from the real sign-in. Signing out deletes the account's
  tokens on every device. OWASP's session management guidance: timeouts and
  logout "must be enforced server-side".

  The session also carries the name, photo, provider and Terms version, so
  no request reads the database (they change only at sign-in, which always
  makes a new session).

  Socket tokens (Phoenix.Token, a day) name the session token they were
  made from (its SHA-256 — the cookie's own value never reaches page
  scripts) and are refused once it is gone.

  Cookies from before this design (a sign-in time, no token) are simply no
  longer a sign-in: everyone signed in once more at the switch (owner).
  """

  alias Hoodride.SessionTokens

  @token_salt "user socket"
  @token_max_s 86_400

  @doc """
  The signed-in user for a session map (string or atom keys) —
  `%{id, name, photo, provider, terms_version, token}` — or nil. `token` is
  the session token's info (Hoodride.SessionTokens.lookup/1). NO DATABASE READ.
  """
  def session_user(session) when is_map(session) do
    with {:ok, token} <- SessionTokens.lookup(get(session, "user_token")),
         id when id == token.user_id <- get(session, "user_id"),
         name when is_binary(name) <- get(session, "name") do
      %{
        id: id,
        name: name,
        photo: get(session, "photo"),
        provider: get(session, "provider"),
        terms_version: get(session, "terms_version"),
        token: token
      }
    else
      _ -> nil
    end
  end

  def session_user(_), do: nil

  defp get(session, key),
    do: Map.get(session, key) || Map.get(session, String.to_existing_atom(key))

  @doc """
  Sign `user` in on `conn`: a new token (the browser's previous one of the
  same account deleted — Hoodride.SessionTokens.create/2), a fresh session
  (OWASP: renew on sign-in) with the name, photo, provider and Terms version
  every request needs. `{:ok, conn}`, or `:error` when the database couldn't.
  """
  def sign_in(conn, user) do
    case SessionTokens.create(user.id, Plug.Conn.get_session(conn, :user_token)) do
      {:ok, raw} ->
        {:ok,
         conn
         |> Plug.Conn.configure_session(renew: true)
         |> Plug.Conn.put_session(:user_id, user.id)
         |> Plug.Conn.put_session(:user_token, raw)
         |> Plug.Conn.put_session(:name, user.name)
         |> Plug.Conn.put_session(:photo, user.photo)
         |> Plug.Conn.put_session(:provider, user.provider)
         # the Terms version this account agreed to (Hoodride.Terms): the
         # token check reads it here, not from the database
         |> Plug.Conn.put_session(:terms_version, Map.get(user, :terms_version))
         |> Plug.Conn.delete_session(:signed_in_at)}

      {:error, _} ->
        :error
    end
  end

  @doc """
  The app is in use: a week-old token is replaced (Hoodride.SessionTokens.
  rotate/1) and the new one put in the cookie, which also renews the
  cookie's 30 days. If that can't be done now the old token simply stays in
  use. Returns the conn with `current_user` updated.
  """
  def keep_signed_in(%Plug.Conn{assigns: %{current_user: %{token: token} = user}} = conn) do
    with true <- SessionTokens.due?(token),
         {:ok, raw} <- SessionTokens.rotate(Plug.Conn.get_session(conn, :user_token)),
         {:ok, new} <- SessionTokens.lookup(raw) do
      conn
      |> Plug.Conn.put_session(:user_token, raw)
      |> Plug.Conn.assign(:current_user, %{user | token: new})
    else
      _ -> conn
    end
  end

  def keep_signed_in(conn), do: conn

  @doc """
  A socket token for a signed-in `user` (as `session_user/1` returns it):
  the account, the session token it comes from (its SHA-256), and the name
  and photo the socket needs, so a connect reads no database (signed, not
  encrypted: only what the holder already knows about themselves).
  """
  def socket_token(%{id: id, name: name, photo: photo, token: %{hash: hash}}),
    do:
      Phoenix.Token.sign(HoodrideWeb.Endpoint, @token_salt, %{
        u: id,
        t: hash,
        iat: System.system_time(:millisecond),
        n: name,
        p: photo
      })

  @doc """
  The user a socket token belongs to (`%{id, name, photo, token_hash}`), or
  nil: forged, older than a day, or its session token gone (signed out,
  account deleted, expired). Tokens from before (no session token named)
  are refused — the app fetches a new one, and a browser no longer signed in
  goes to the sign-in screen.
  """
  def token_user(token) when is_binary(token) do
    case Phoenix.Token.verify(HoodrideWeb.Endpoint, @token_salt, token, max_age: @token_max_s) do
      {:ok, %{u: id, t: hash, n: name, p: photo}} when is_integer(id) and is_binary(hash) ->
        if signed_in?(id, hash), do: %{id: id, name: name, photo: photo, token_hash: hash}

      _ ->
        nil
    end
  end

  def token_user(_), do: nil

  @doc "Is the session token (`hash`) still a valid sign-in of `user_id`? (every channel join asks)"
  def signed_in?(user_id, hash) do
    match?({:ok, %{user_id: ^user_id}}, SessionTokens.lookup_hash(hash))
  end
end
