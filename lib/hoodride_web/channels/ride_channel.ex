defmodule HoodrideWeb.RideChannel do
  @moduledoc """
  Exactly two people can ever be on a ride topic — enforced at join.
  Exact live positions travel here and nowhere else (privacy rule 4
  as physics, not policy). High-frequency traffic flows peer-to-peer
  over the topic; decisions (pin, end) go through the ride GenServer.
  """
  use HoodrideWeb, :channel

  alias Hoodride.Rides

  defguardp valid_coords(lat, lng)
            when is_number(lat) and is_number(lng) and lat >= -90 and lat <= 90 and
                   lng >= -180 and lng <= 180

  # a socket that lost the session is refused first (HoodrideWeb.SessionGate);
  # then every join spends the user's join budget: a refused join does no
  # work at all (HoodrideWeb.JoinBudget)
  @impl true
  def join(topic, params, socket) do
    with :ok <- HoodrideWeb.SessionGate.check(socket),
         :ok <- HoodrideWeb.JoinBudget.check(socket),
         do: do_join(topic, params, socket)
  end

  defp do_join("ride:" <> ride_id, _params, socket) do
    case Rides.get(ride_id) do
      {:ok, st} ->
        if socket.assigns.user_id in [st.rider, st.driver] do
          # look again once subscribed (see handle_info(:confirm_seat))
          send(self(), :confirm_seat)

          {:ok, %{pin: st.pin, rider: st.rider, driver: st.driver, arrived: st.arrived},
           assign(socket, :ride_id, ride_id)}
        else
          {:error, %{reason: "not_yours"}}
        end

      _ ->
        {:error, %{reason: "gone"}}
    end
  end

  # RIDE BUDGET (per user, Hoodride.RateBudget: every connection's ride
  # channel spends from one allowance): the send filter caps an honest client at ~40 position updates
  # a minute (one per 1.5s tick), so 120/min with burst 30 is ~3x headroom.
  # It protects the ride partner from a flooded position stream. Over the
  # limit, fire-and-forget events are dropped; replying ones say so.
  @ride_per_minute Hoodride.Limits.ride_per_minute()
  @ride_burst Hoodride.Limits.ride_burst()
  @noreply_events ~w(pos set_pin clear_pin end_ride)

  @impl true
  def handle_in(name, payload, socket) do
    case Hoodride.RateBudget.spend(socket, :ride, @ride_per_minute, @ride_burst) do
      {:ok, socket} -> event(name, payload, socket)
      {:deny, socket} when name in @noreply_events -> {:noreply, socket}
      {:deny, socket} -> {:reply, {:error, %{reason: "rate_limited"}}, socket}
    end
  end

  # live position — kept by the ride as your LAST one (for a partner who
  # rejoins), THEN relayed to the other party: stored first, so a joiner is
  # never handed a position older than one already sent past it. Only while
  # the sender still holds a seat in THIS ride: a channel can outlive its
  # ride (an app that missed "ended"), and an exact position must never
  # flow — or be kept — after the ride is over.
  defp event("pos", %{"lat" => lat, "lng" => lng}, socket)
       when valid_coords(lat, lng) do
    %{user_id: user_id, ride_id: ride_id} = socket.assigns

    if Rides.ride_id_of_user(user_id) == ride_id and
         Rides.position(ride_id, user_id, %{lat: lat, lng: lng}) == :ok do
      broadcast_from!(socket, "peer_pos", %{from: user_id, lat: lat, lng: lng})
    end

    {:noreply, socket}
  end

  defp event("set_pin", %{"lat" => lat, "lng" => lng}, socket)
       when valid_coords(lat, lng) do
    Rides.set_pin(socket.assigns.ride_id, socket.assigns.user_id, %{lat: lat, lng: lng})
    {:noreply, socket}
  end

  defp event("clear_pin", _payload, socket) do
    Rides.set_pin(socket.assigns.ride_id, socket.assigns.user_id, nil)
    {:noreply, socket}
  end

  defp event("arrived", _payload, socket) do
    case Rides.arrived(socket.assigns.ride_id, socket.assigns.user_id) do
      :ok -> {:reply, :ok, socket}
      {:error, reason} -> {:reply, {:error, %{reason: to_string(reason)}}, socket}
    end
  end

  defp event("end_ride", _payload, socket) do
    Rides.end_ride(socket.assigns.ride_id, socket.assigns.user_id)
    {:noreply, socket}
  end

  # malformed payloads get an error reply, never a channel crash
  defp event(_event, _payload, socket) do
    {:reply, {:error, %{reason: "bad_request"}}, socket}
  end

  # THE JOIN GAP: Phoenix subscribes to the topic only AFTER join/3 returns,
  # so a ride ending in between broadcast "ended" to nobody here — the join
  # succeeded onto a dead ride (the monster test caught a rider sitting in
  # one). This runs once subscribed. Every end frees the seats BEFORE it
  # broadcasts, so: our seat still on this ride → "ended" is still to come
  # and will reach us; otherwise it may have passed → say it ourselves.
  #
  # It is also where a (re)joining partner is handed the other's LAST
  # position (Rides.peer_position/2), with its age: AFTER subscribing, so
  # nothing sent from here on can slip between that read and the stream —
  # this channel handles one message at a time, so what's handed over always
  # comes before anything newer. (A reloaded app saw nobody until the
  # partner's next send: up to ~24 s for someone standing at the pickup.)
  @impl true
  def handle_info(:confirm_seat, socket) do
    %{user_id: user_id, ride_id: ride_id} = socket.assigns

    if Rides.ride_id_of_user(user_id) == ride_id do
      case Rides.peer_position(ride_id, user_id) do
        %{} = p -> push(socket, "peer_pos", p)
        nil -> :ok
      end

      {:noreply, socket}
    else
      handle_out("ended", %{by: nil}, socket)
    end
  end

  # "ended" is the ride's last word: deliver it, then close this channel
  # from the server side (a clean close — the app doesn't rejoin), so no
  # lingering subscriber can hear anything after the ride.
  #
  # "peer_pos" comes through here too, not straight to the connection
  # (Phoenix's default for a broadcast): the sender's seat check and the
  # ride's end aren't ordered, so a position sent at the moment of the end
  # could land AFTER "ended" (the mega monster caught one). Checked against
  # the RECEIVER's seat — every end frees the seats before it broadcasts —
  # an exact position reaches only someone still seated in this ride. A
  # ride is two people at ~1 position a second: the extra hop is nothing.
  intercept ["ended", "peer_pos"]

  @impl true
  def handle_out("ended", payload, socket) do
    push(socket, "ended", payload)
    {:stop, :normal, socket}
  end

  def handle_out("peer_pos", payload, socket) do
    if Rides.ride_id_of_user(socket.assigns.user_id) == socket.assigns.ride_id,
      do: push(socket, "peer_pos", payload)

    {:noreply, socket}
  end
end
