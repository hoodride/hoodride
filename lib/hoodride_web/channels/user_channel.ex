defmodule HoodrideWeb.UserChannel do
  @moduledoc """
  Each client joins exactly one of these: its own. Carries the user's
  outbound actions (position updates, hand toggles) and doubles as the
  presence heartbeat — join marks online, terminate starts the grace clock.
  """
  use HoodrideWeb, :channel

  alias Hoodride.Geo

  # The box warns at 500 (HoodChatList); this is a looser BACKSTOP: phones
  # and the server can run different Unicode versions, and a stacked
  # conjunct ("क्ष्म्य") is 1 character now but 4 under older rules — so a
  # message the box allowed is never refused here
  @max_msg_chars 2000
  # …but one character can carry thousands of stacked marks ("Zalgo"): 20 KB
  # is 500 of the heaviest real characters (👩🏻‍❤️‍💋‍👨🏼 is 35 bytes: 17.5 KB) with
  # room to spare, and more than 30 marks in a row is no language (Unicode's
  # Stream-Safe Text Format: 30 is "significantly beyond what is required
  # for any linguistic usage")
  @max_msg_bytes 20_480
  @stacked_marks ~r/\p{M}{31}/u
  # H3 cells are ~16 chars; anything bigger is garbage, not geography
  @max_cell_bytes 24

  defguardp valid_cell(cell) when is_binary(cell) and byte_size(cell) <= @max_cell_bytes

  # The sender's block, shared with whoever they message or ask for a ride
  # (ARCHITECTURE.md "Distances") — a well-formed block, and NEVER an online
  # driver's: drivers are public as cars already, and a driver's messages
  # must not carry more about them. Anything else: nil, the message still goes.
  defp shareable_spot(socket, %{"spot" => spot}) when valid_cell(spot) and spot != "" do
    if Geo.driver_on_map?(socket.assigns.user_id), do: nil, else: spot
  end

  defp shareable_spot(_socket, _payload), do: nil

  # EVENTS BUDGET: every inbound event spends from the user's one events
  # budget (Hoodride.RateBudget — per USER, so a rejoin or a second
  # connection can't refill it).
  # Honest peak: a driver moving nonstop sends ~40 position updates/min
  # (one per 1.5s tick) plus a few taps, so 120/min is ~3x headroom; the
  # burst of 30 covers reconnect flurries. A flooding script walls out in
  # about a second. Fire-and-forget updates are silently dropped when over;
  # events that expect a reply get "rate_limited". Never a hang-up: this
  # channel carries chat, requests and presence.
  @events_per_minute 120
  @events_burst 30
  @noreply_events ~w(driver_update driver_offline hand_up hand_down)

  # a socket that lost the session is refused first (HoodrideWeb.SessionGate);
  # then every join spends the user's join budget: a refused join does no
  # work at all (HoodrideWeb.JoinBudget)
  @impl true
  def join(topic, params, socket) do
    with :ok <- HoodrideWeb.SessionGate.check(socket),
         :ok <- HoodrideWeb.JoinBudget.check(socket),
         do: do_join(topic, params, socket)
  end

  # the EXACT id as text: "user:abc" used to crash the join, and "user:0<id>"
  # or "user:+<id>" joined a topic nothing is ever sent to (server review,
  # 2026-11-08)
  defp do_join("user:" <> id, _params, socket) do
    if id == Integer.to_string(socket.assigns.user_id) do
      # the live-channel directory IS presence: this entry vanishes with the
      # process (clean close, crash, or dirty socket death alike), so a spare
      # tab closing can never mark a still-connected user as departing
      # the value is this channel's socket, so a NEW socket of this account
      # can tell which of its older sockets to hand over (HoodrideWeb.UserSocket)
      {:ok, _} =
        Registry.register(Hoodride.UserChannels, socket.assigns.user_id, socket.transport_pid)

      Geo.user_connected(socket.assigns.user_id)

      # a planned restart is announced here first (HoodrideWeb.RestartNotice)
      Phoenix.PubSub.subscribe(Hoodride.PubSub, HoodrideWeb.RestartNotice.topic())

      # NEWEST WINS: one live session per account. Register FIRST (so
      # presence never lapses during the hand-over), then kick every older
      # session. A reload's stale socket dies now instead of after a ~60s
      # heartbeat timeout; another device's session is told it moved.
      hand_over(socket)

      # the tab's stamp: it carries it on every automatic reconnect
      # (Hoodride.SessionStamp)
      {:ok, %{stamp: socket.assigns[:stamp]}, socket}
    else
      {:error, %{reason: "not_yours"}}
    end
  end

  # "Older" by the tab's stamp (Hoodride.SessionStamp: the device chosen
  # last has the highest), not by which join lands last. On a quick refresh
  # the page just left is still running for a moment and its join can land
  # with — or after — the new page's (2026-11-01, the browser journeys):
  # each kicked the other, and the page in use was told it moved too. Now a
  # page that finds a NEWER one already joined steps aside itself. Equal or
  # unknown stamps (the same tab's own leftover, an old app): newest join
  # wins, as before.
  defp hand_over(socket) do
    user_id = socket.assigns.user_id
    mine = socket.assigns[:stamp]
    stamps = Map.new(Registry.lookup(Hoodride.SocketStamps, user_id))

    others =
      for {pid, transport} <- Registry.lookup(Hoodride.UserChannels, user_id),
          pid != self(),
          do: {pid, Map.get(stamps, transport)}

    if Enum.any?(others, fn {_pid, stamp} -> newer?(stamp, mine) end) do
      # told once its join reply is out (handle_info below)
      send(self(), :session_moved)
    else
      for {pid, _} <- others, do: send(pid, :session_moved)
    end
  end

  defp newer?(stamp, mine), do: is_integer(stamp) and is_integer(mine) and stamp > mine

  # Every action first: is this connection's sign-in still there? Signed
  # out (or the account deleted) a moment ago, its "disconnect" may not have
  # landed yet — a ✋ or a message queued meanwhile must not go through (it
  # left a ghost hand until the sweeper's grace). One memory lookup.
  @impl true
  def handle_in(name, payload, socket) do
    if HoodrideWeb.Auth.signed_in?(socket.assigns.user_id, socket.assigns[:token_hash]),
      do: budgeted(name, payload, socket),
      else: signed_out(socket)
  end

  defp signed_out(socket) do
    send(socket.transport_pid, %Phoenix.Socket.Broadcast{
      topic: "user_socket:#{socket.assigns.user_id}",
      event: "disconnect",
      payload: %{}
    })

    {:reply, {:error, %{reason: "signed_out"}}, socket}
  end

  defp budgeted(name, payload, socket) do
    case Hoodride.RateBudget.spend(socket, :events, @events_per_minute, @events_burst) do
      {:ok, socket} -> event(name, payload, socket)
      {:deny, socket} when name in @noreply_events -> {:noreply, socket}
      {:deny, socket} -> {:reply, {:error, %{reason: "rate_limited"}}, socket}
    end
  end

  # driver broadcasting availability (only while online-as-driver): cells
  # only, like a hand — `spot` is the block-level display hex the app chose.
  # Any lat/lng an older app still sends is ignored: exact positions travel
  # only inside a ride (RideChannel).
  defp event("driver_update", %{"cell" => cell, "spot" => spot} = payload, socket)
       when valid_cell(cell) and valid_cell(spot) do
    driver_update(socket, cell, spot, payload)
  end

  defp event("driver_update", %{"cell" => cell} = payload, socket)
       when valid_cell(cell) and not is_map_key(payload, "spot") do
    driver_update(socket, cell, nil, payload)
  end

  defp event("driver_offline", _payload, socket) do
    Geo.driver_offline(socket.assigns.user_id)
    {:noreply, socket}
  end

  # rider demand beacon — cell only, never an exact position
  defp event("hand_up", %{"cell" => cell, "spot" => spot} = payload, socket)
       when valid_cell(cell) and valid_cell(spot) do
    if Hoodride.Rides.ride_id_of_user(socket.assigns.user_id) == nil do
      Geo.hand_up(socket.assigns.user_id, cell, spot, valid_parents(payload))
    end

    {:noreply, socket}
  end

  defp event("hand_up", %{"cell" => cell} = payload, socket)
       when valid_cell(cell) and not is_map_key(payload, "spot") do
    if Hoodride.Rides.ride_id_of_user(socket.assigns.user_id) == nil do
      Geo.hand_up(socket.assigns.user_id, cell)
    end

    {:noreply, socket}
  end

  defp event("hand_down", _payload, socket) do
    Geo.hand_down(socket.assigns.user_id)
    {:noreply, socket}
  end

  # ----- chat: all messages route through the recipient's user channel -----
  defp event("send_msg", %{"to" => to_id, "text" => text} = payload, socket)
       when is_integer(to_id) and is_binary(text) and text != "" do
    cond do
      to_id == socket.assigns.user_id ->
        {:reply, {:error, %{reason: "self"}}, socket}

      # bytes first: cheap, and it bounds the counting below
      byte_size(text) > @max_msg_bytes or String.length(text) > @max_msg_chars ->
        {:reply, {:error, %{reason: "too_long"}}, socket}

      Regex.match?(@stacked_marks, text) ->
        {:reply, {:error, %{reason: "stacked_marks"}}, socket}

      # the same message again (the app's retry: its reply was lost): the
      # same receipt — never delivered twice, never counted twice
      (receipt = Hoodride.Chat.sent_receipt(socket.assigns.user_id, client_id(payload))) != nil ->
        {:reply, {:ok, receipt}, socket}

      true ->
        me = socket.assigns.user_id

        # no "does this user exist?" check up front: it told anyone which
        # ids are real. A missing id simply isn't reachable (HoodrideWeb.Reach).
        with {:ok, cold?} <- reach(socket, to_id),
             :ok <-
               limits([
                 {cold_allowed(cold?, me), "too_many_new_chats"},
                 {Hoodride.Throttle.message_allowed(me, to_id), "rate_limited"}
               ]) do
          spot = shareable_spot(socket, payload)
          {:ok, receipt} = Hoodride.Chat.send_message(socket.assigns.user, to_id, text, spot)
          Hoodride.Chat.remember_sent(me, client_id(payload), receipt)
          # it went: only now are the allowances spent
          Hoodride.Throttle.sent_message(me, to_id)
          if cold?, do: Hoodride.Throttle.started_conversation(me)
          {:reply, {:ok, receipt}, socket}
        else
          {:error, reply} -> {:reply, {:error, reply}, socket}
        end
    end
  end

  # ----- requests: rider creates, driver answers -----
  defp event("request_ride", %{"to" => driver_id} = payload, socket) when is_integer(driver_id) do
    me = socket.assigns.user_id

    # reachability FIRST: a stranger's id learns nothing from the cooldown
    # or the request's own refusals
    with {:ok, cold?} <- reach(socket, driver_id),
         :ok <- limits([{cold_allowed(cold?, me), "too_many_new_chats"}]),
         :ok <- request_cooldown(me, driver_id) do
      case Hoodride.Requests.create(
             socket.assigns.user,
             driver_id,
             shareable_spot(socket, payload)
           ) do
        # it went: only now is a new contact spent (a refusal — waiting on
        # another driver, the driver gone — spends nothing)
        :ok ->
          if cold?, do: Hoodride.Throttle.started_conversation(me)
          {:reply, :ok, socket}

        {:error, reason} ->
          {:reply, {:error, %{reason: to_string(reason)}}, socket}
      end
    else
      {:error, reply} -> {:reply, {:error, reply}, socket}
    end
  end

  defp event("cancel_request", _payload, socket) do
    Hoodride.Requests.cancel(socket.assigns.user_id)
    {:reply, :ok, socket}
  end

  defp event("accept_request", %{"rider_id" => rider_id}, socket)
       when is_integer(rider_id) do
    case Hoodride.Requests.accept(socket.assigns.user, rider_id) do
      {:ok, _ride_id} -> {:reply, :ok, socket}
      {:error, reason} -> {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  defp event("decline_request", %{"rider_id" => rider_id}, socket)
       when is_integer(rider_id) do
    Hoodride.Requests.decline(socket.assigns.user_id, rider_id)
    {:reply, :ok, socket}
  end

  # malformed payloads get an error reply, never a channel crash
  defp event(_event, _payload, socket) do
    {:reply, {:error, %{reason: "bad_request"}}, socket}
  end

  defp driver_update(socket, cell, spot, payload) do
    # mid-ride users don't appear on the browse map, whatever their client says
    if Hoodride.Rides.ride_id_of_user(socket.assigns.user_id) == nil do
      Geo.driver_update(socket.assigns.user, cell, spot, valid_parents(payload))
    end

    {:noreply, socket}
  end

  # An older session being replaced: tell the app FIRST (so it turns off
  # auto-reconnect — otherwise two devices would keep kicking each other),
  # then close this whole socket. Both messages go to the same transport
  # process, so the push is delivered before the disconnect.
  @impl true
  def handle_info(:session_moved, socket) do
    push(socket, "session_moved", %{})

    send(socket.transport_pid, %Phoenix.Socket.Broadcast{
      topic: socket.topic,
      event: "disconnect",
      payload: %{}
    })

    {:noreply, socket}
  end

  # a planned restart: the app reconnects once inside this window
  # (HoodrideWeb.RestartNotice, sync.js restartWait)
  def handle_info({:restarting, window}, socket) do
    push(socket, "restarting", window)
    {:noreply, socket}
  end

  @impl true
  def terminate(_reason, socket) do
    Geo.user_disconnected(socket.assigns.user_id)
    :ok
  end

  # Cold contact = reaching someone you have NO conversation and NO open
  # request with. It must be someone on your screen (HoodrideWeb.Reach), and
  # only that spends the new-conversation budget; replies and follow-ups are
  # free. (Checking both stops a request-then-message from being charged
  # twice — a request doesn't create a conversation.) A refused contact
  # spends nothing: the budget is only LOOKED AT here, and charged once the
  # request or message has gone (Hoodride.Throttle).
  # → {:ok, cold?} | {:error, reply}
  defp reach(socket, other) do
    case HoodrideWeb.Reach.check(socket, other) do
      :related -> {:ok, false}
      :cold -> {:ok, true}
      {:error, reply} -> {:error, reply}
    end
  end

  defp cold_allowed(false, _me), do: :ok
  defp cold_allowed(true, me), do: Hoodride.Throttle.new_conversation_allowed(me)

  # every limit is looked at (nothing charged); if several refuse, the one
  # lifting LAST is named — its wait is the real one
  defp limits(checks) do
    case for({{:deny, ms}, reason} <- checks, do: {ms, reason}) do
      [] ->
        :ok

      refused ->
        {ms, reason} = Enum.max_by(refused, &elem(&1, 0))
        {:error, %{reason: reason, retry_ms: ms}}
    end
  end

  # The cooldown is STARTED when a request to this driver ends with a decline
  # or a cancel (in Requests), so "no" sticks for a full minute after the
  # answer. Here it's only read. A second request while one is still open
  # never reaches a cooldown — Requests refuses it as already_requested.
  defp request_cooldown(me, driver_id) do
    throttle(Hoodride.Throttle.request_cooldown(me, driver_id), "request_cooldown")
  end

  defp throttle(:ok, _reason), do: :ok
  defp throttle({:deny, retry_ms}, reason), do: {:error, %{reason: reason, retry_ms: retry_ms}}

  # client-computed coarse parent cells for the aggregate tier — opaque strings,
  # capped and size-checked; anything malformed is simply dropped
  defp valid_parents(%{"parents" => parents}) when is_list(parents) do
    parents
    |> Enum.filter(&(is_binary(&1) and byte_size(&1) <= @max_cell_bytes))
    |> Enum.take(4)
  end

  defp valid_parents(_), do: []

  # a message's client id: a short string, else none (then each send is new)
  defp client_id(%{"cid" => cid}) when is_binary(cid) and byte_size(cid) in 1..64, do: cid
  defp client_id(_), do: nil
end
