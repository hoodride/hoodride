defmodule HoodrideWeb.UserSocket do
  @moduledoc """
  The one websocket of an app. ONE SOCKET PER ACCOUNT, newest wins.

  A socket and its channels are separate in Phoenix: a client can connect
  and never join anything, and newest-wins used to act only on a user
  channel JOIN — so sockets that never joined one (idle, or a script's)
  piled up without limit, kept alive by heartbeats. Now, at connect:

    1. the user's CONNECT budget (Hoodride.RateBudget) is checked first: a
       connect loop isn't free (auth + a database read each), and a refused
       connect kicks no one. Phoenix's client retries with backoff.
    2. every OLDER socket of the account is replaced. One that holds a user
       channel (a real tab) gets the hand-over: its channel pushes
       `session_moved` (the app stops auto-reconnecting and offers "Use
       here") and then closes its own socket — one process does both, so
       the message always lands first and two tabs never kick each other
       in a loop. One without a user channel can't be told anything: it's
       closed directly.
    3. WHO gets in at all (Hoodride.SessionStamp — the device you chose
       last wins): a connect that is a CHOICE (`takeover=true`: a page
       load, a refresh, "Use here") gets a new stamp and takes over. An
       AUTOMATIC reconnect carries its tab's `stamp` and takes over only
       if no higher stamp is known; otherwise the socket is accepted but
       MOVED: it kicks no one, every join is refused with `session_moved`
       (HoodrideWeb.SessionGate) and it is closed. A connect with neither
       param (an old cached app, a script) is a choice — as before.
    4. a JOIN DEADLINE: a socket that hasn't joined its user channel within
       10 s is closed. The real app joins within milliseconds; Socket.IO
       does the same by default (its connectTimeout is cleared only by a
       namespace join), and 5–10 s is the usual convention for "identify
       or be closed". It also settles two tabs loading at the same instant
       (the one closed before joining reconnects; the other gets the
       ordinary hand-over).

  Older sockets are found through Phoenix's own per-socket topic: every
  socket's process subscribes to `id/1` ("user_socket:<id>") — the
  documented way to reach "all sockets of a user" — and connect/3 runs
  BEFORE the new socket subscribes, so the topic lists exactly the old ones.
  """
  # connects at debug, not info (as joins: HoodrideWeb.channel/0) — a line per
  # connect let a burst push the logger into drop mode, losing its errors
  use Phoenix.Socket, log: :debug

  alias Hoodride.{RateBudget, SessionStamp}
  alias HoodrideWeb.Auth

  channel "world", HoodrideWeb.WorldChannel
  channel "user:*", HoodrideWeb.UserChannel
  channel "ride:*", HoodrideWeb.RideChannel

  # a page load or reconnect is one connect; a phone on flaky Wi-Fi
  # reconnects at most ~10 times a minute (the client backs off): 21 at
  # once, then one every 3 s
  @connects_per_minute 20
  @connects_burst 20

  # the latest connect of each user and its deadline token
  @slots :socket_slots

  def init_table do
    Hoodride.ETS.new(@slots, [:named_table, :public, :set])
    :ok
  end

  # WHO, decided by HoodrideWeb.Auth the same way on every path (a token
  # issued before the account's last sign-out, or a session past its 30
  # days, is refused):
  #   * the app: its token in the WebSocket protocol header (`auth_token`) —
  #     not the URL, so never in a proxy's access log;
  #   * scripts: `?token=` in the URL (filtered from Phoenix's logs);
  #   * tests: a session (a browser never has one here — Phoenix gives a
  #     socket the session only with a CSRF token, which our page lacks).
  @impl true
  def connect(params, socket, connect_info) do
    case handshake_budget(connect_info) do
      :ok -> connect_checked(params, socket, connect_info)
      :deny -> {:error, :rate_limited}
    end
  end

  # PER ADDRESS, BEFORE THE TOKEN (OWASP's WebSocket guidance: per-user limits
  # first, per-IP "where user identification isn't available" — here, before
  # the token is checked). Every attempt counts, valid or not: a real person
  # connects about once per page load, so the signed-out HTTP budget's
  # generous numbers fit a café on one Wi-Fi. A forged token costs ~6.5 µs to
  # refuse; a replayed revoked one a database read — this caps both. IPv6 per
  # /64. Cloudflare counts per data center; this one server sees every
  # attempt. `config :hoodride, :ws_budget` (nil = off: dev, the monster is one
  # address). The account's own connect budget still applies after.
  defp handshake_budget(%{peer_data: %{address: peer}} = connect_info) do
    case Application.get_env(:hoodride, :ws_budget) do
      nil ->
        :ok

      limits ->
        ip =
          HoodrideWeb.ClientIp.from_headers(
            peer,
            Map.get(connect_info, :x_headers, []),
            Application.get_env(:hoodride, :trusted_proxies, [])
          )

        key = {:ws, HoodrideWeb.ClientIp.budget_key(ip)}

        case RateBudget.spend(key, :ws, limits[:per_minute], limits[:burst]) do
          {:ok, _} -> :ok
          {:deny, _} -> :deny
        end
    end
  end

  # no peer data: a test calling connect/3 directly, never a real transport
  defp handshake_budget(_connect_info), do: :ok

  defp connect_checked(params, socket, connect_info) do
    user =
      case connect_info do
        %{auth_token: token} when is_binary(token) -> Auth.token_user(token)
        _ when is_map_key(params, "token") -> Auth.token_user(params["token"])
        %{session: session} when is_map(session) -> Auth.session_user(session)
        _ -> nil
      end

    authorize(socket, user, params)
  end

  defp authorize(_socket, nil, _params), do: :error

  defp authorize(socket, user, params) do
    with {:ok, _} <- RateBudget.spend(user.id, :connect, @connects_per_minute, @connects_burst) do
      socket =
        socket
        |> assign(:user_id, user.id)
        |> assign(:user, %{id: user.id, name: user.name, photo: user.photo})
        # the sign-in this connection belongs to: every join checks it is
        # still there (HoodrideWeb.SessionGate) — a connect made while a
        # sign-out ran can't keep going
        |> assign(:token_hash, token_hash(user))

      {:ok, admit(socket, user.id, choice?(params), stamp(params))}
    else
      {:deny, _} -> {:error, :rate_limited}
    end
  end

  defp token_hash(%{token_hash: hash}), do: hash
  defp token_hash(%{token: %{hash: hash}}), do: hash

  # who gets in (Hoodride.SessionStamp). Runs in the process that becomes
  # this socket's transport, so the stamp registered here lives exactly as
  # long as the connection.
  defp admit(socket, user_id, choice?, stamp) do
    live = for {_pid, s} <- Registry.lookup(Hoodride.SocketStamps, user_id), do: s

    case SessionStamp.decide(choice?, stamp, SessionStamp.highest(user_id), live) do
      :take_over ->
        stamp = if choice?, do: SessionStamp.issue(), else: stamp
        SessionStamp.saw(user_id, stamp)
        take_over(user_id)
        {:ok, _} = Registry.register(Hoodride.SocketStamps, user_id, stamp)
        start_join_deadline(user_id)
        assign(socket, :stamp, stamp)

      :moved ->
        # every join refuses it (HoodrideWeb.SessionGate); one that never
        # joins is closed after the usual deadline
        Process.send_after(self(), disconnect(user_id), join_deadline_ms())
        assign(socket, :moved, true)
    end
  end

  # neither param: an older app or a script — a choice, as before
  defp choice?(%{"takeover" => "true"}), do: true

  defp choice?(params) when is_map_key(params, "takeover") or is_map_key(params, "stamp"),
    do: false

  defp choice?(_params), do: true

  # a stamp this server could have issued, or nil
  defp stamp(%{"stamp" => s}) when is_binary(s) and byte_size(s) <= 20 do
    case Integer.parse(s) do
      {n, ""} when n > 0 -> if n <= SessionStamp.latest(), do: n
      _ -> nil
    end
  end

  defp stamp(_params), do: nil

  defp disconnect(user_id),
    do: %Phoenix.Socket.Broadcast{topic: socket_topic(user_id), event: "disconnect", payload: %{}}

  @impl true
  def id(socket), do: socket_topic(socket.assigns.user_id)

  defp socket_topic(user_id), do: "user_socket:#{user_id}"

  # replace every older socket of this account (see the moduledoc)
  defp take_over(user_id) do
    topic = socket_topic(user_id)

    case for({pid, _} <- Registry.lookup(Hoodride.PubSub, topic), do: pid) do
      [] ->
        :ok

      olds ->
        # the hand-over for sockets that hold a user channel: that channel
        # tells its app, then closes its own socket
        handed =
          for {chan, transport} <- Registry.lookup(Hoodride.UserChannels, user_id),
              transport in olds do
            send(chan, :session_moved)
            transport
          end

        for transport <- olds -- handed do
          send(transport, %Phoenix.Socket.Broadcast{
            topic: topic,
            event: "disconnect",
            payload: %{}
          })
        end

        :ok
    end
  end

  # Only the LATEST connect's deadline counts: a newer connect replaced this
  # socket (and overwrote the token). When it fires and the account still
  # has no user channel, its socket is closed.
  defp start_join_deadline(user_id) do
    token = make_ref()
    :ets.insert(@slots, {user_id, token})

    {:ok, _} =
      :timer.apply_after(join_deadline_ms(), __MODULE__, :enforce_join_deadline, [user_id, token])

    :ok
  end

  @doc false
  # (`registry` only so a test can stand in a stopped one)
  def enforce_join_deadline(user_id, token, registry \\ Hoodride.UserChannels) do
    latest? = :ets.select_delete(@slots, [{{user_id, token}, [], [true]}]) == 1

    # a deploy: the server is stopping and the user-channel registry has
    # already shut down (its table is gone) — nothing left to enforce. Those
    # deadlines used to crash ("unknown registry"): 124 errors in one second
    # of a 4,000-person deploy, burying any real one.
    if latest? and :ets.whereis(registry) != :undefined and
         Registry.lookup(registry, user_id) == [] do
      HoodrideWeb.Endpoint.broadcast(socket_topic(user_id), "disconnect", %{})
    end

    :ok
  end

  defp join_deadline_ms, do: Application.get_env(:hoodride, :join_deadline_ms, 10_000)
end
