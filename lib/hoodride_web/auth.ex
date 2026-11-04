defmodule HoodrideWeb.Auth do
  @moduledoc """
  Who is signed in — decided on the SERVER, the same way for every path
  (HTTP, a socket token in the header or the URL, a socket session).

  Sessions live in a signed cookie, and Plug's cookie `max_age` is only the
  browser's expiry: a copied cookie never expired, and logout only deleted
  it in one browser. OWASP's session management guidance: timeouts and
  logout "must be enforced server-side". So:

    * a session carries its sign-in time (`signed_in_at`, ms);
    * it is valid for at most #{div(30 * 86_400_000, 86_400_000)} days (a phone app people
      expect to stay signed into; OWASP's 4–8 h is for office apps used
      all day);
    * and only if it is newer than the account's `logged_out_at` — logout
      signs the account out EVERYWHERE (one live session per account
      already: Hoodride.SessionStamp).

  Socket tokens carry their issue time too (`iat`) and follow the same
  `logged_out_at` rule; Phoenix.Token's own max_age gives them a day.
  """

  alias Hoodride.Accounts

  @session_max_ms 30 * 86_400_000
  @token_salt "user socket"
  @token_max_s 86_400

  @doc """
  The signed-in user for a session map (string or atom keys) —
  `%{id, name, photo, provider}` — or nil. NO DATABASE READ: the session
  carries the name, photo and provider from sign-in (they change only at
  sign-in, which always makes a new session), and a sign-out or deletion
  since is the in-memory denylist (Hoodride.SignOuts, kept in its own table
  so it survives restarts). After a restart thousands of apps ask at once,
  and every request used to read the user row. A session from before these
  were carried is checked against the database as it used to be.
  """
  def session_user(session) when is_map(session) do
    with id when is_integer(id) <- get(session, "user_id"),
         at when is_integer(at) <- get(session, "signed_in_at"),
         true <- fresh?(at, @session_max_ms) do
      case get(session, "name") do
        name when is_binary(name) ->
          if Hoodride.SignOuts.allowed?(id, at),
            do: %{
              id: id,
              name: name,
              photo: get(session, "photo"),
              provider: get(session, "provider"),
              terms_version: get(session, "terms_version")
            }

        _ ->
          legacy_session_user(id, at)
      end
    else
      _ -> nil
    end
  end

  def session_user(_), do: nil

  defp legacy_session_user(id, at) do
    with %{} = user <- Accounts.get_user(id),
         true <- valid_since?(user, at, @session_max_ms),
         do: user,
         else: (_ -> nil)
  end

  defp fresh?(at, max_ms), do: System.system_time(:millisecond) - at <= max_ms

  defp get(session, key),
    do: Map.get(session, key) || Map.get(session, String.to_existing_atom(key))

  # issued within `max_ms`, and after the account's last sign-out
  defp valid_since?(user, at, max_ms) do
    now = System.system_time(:millisecond)
    at > (user.logged_out_at || 0) and now - at <= max_ms
  end

  @doc """
  Sign `user` in on `conn`: a fresh session (OWASP: renew on sign-in) with
  its sign-in time — and the name, photo and provider every request needs,
  so none reads the database (signed, not encrypted: only what the holder
  already knows about themselves).
  """
  def sign_in(conn, user) do
    conn
    |> Plug.Conn.configure_session(renew: true)
    |> Plug.Conn.put_session(:user_id, user.id)
    |> Plug.Conn.put_session(:signed_in_at, System.system_time(:millisecond))
    |> Plug.Conn.put_session(:name, user.name)
    |> Plug.Conn.put_session(:photo, user.photo)
    |> Plug.Conn.put_session(:provider, user.provider)
    # the Terms version this account agreed to (Hoodride.Terms): the token
    # check reads it here, not from the database
    |> Plug.Conn.put_session(:terms_version, Map.get(user, :terms_version))
  end

  @doc """
  A socket token for `user`, stamped with its issue time — and carrying the
  name and photo the socket needs, so a connect reads no database (signed,
  not encrypted: only what the holder already knows about themselves).
  """
  def socket_token(user),
    do:
      Phoenix.Token.sign(HoodrideWeb.Endpoint, @token_salt, %{
        u: user.id,
        iat: System.system_time(:millisecond),
        n: user.name,
        p: user.photo
      })

  @doc """
  The user a socket token belongs to (`%{id, name, photo}`), or nil (forged,
  older than a day, legacy, or issued before a sign-out). The sign-out check
  is the in-memory denylist (Hoodride.SignOuts): no database read — the
  capacity test's 3,000 connects at once ran the pool dry. A token from
  before name/photo were carried (any issued before this deploy, gone within
  a day) is checked against the database as it used to be.
  """
  def token_user(token) when is_binary(token) do
    case Phoenix.Token.verify(HoodrideWeb.Endpoint, @token_salt, token, max_age: @token_max_s) do
      # (a day's age is verify's max_age, on the token's own signed time)
      {:ok, %{u: id, iat: iat, n: name, p: photo}} when is_integer(id) and is_integer(iat) ->
        if Hoodride.SignOuts.allowed?(id, iat), do: %{id: id, name: name, photo: photo}

      {:ok, %{u: id, iat: iat}} when is_integer(id) and is_integer(iat) ->
        with %{} = user <- Accounts.get_user(id),
             true <- valid_since?(user, iat, @token_max_s * 1000) do
          %{id: user.id, name: user.name, photo: user.photo}
        else
          _ -> nil
        end

      _ ->
        nil
    end
  end

  def token_user(_), do: nil
end
