defmodule Hoodride.Rides do
  @moduledoc """
  One GenServer per active ride: its mailbox serializes every decision
  (no races), its death is the data's deletion (no cleanup).
  """

  def init_tables do
    Hoodride.ETS.new(:rides_by_user, [:named_table, :public, :set])
    :ok
  end

  def start_ride(rider_id, driver_id) do
    # atomically claim both seats (all-or-nothing) — closes the race where the
    # same driver, on two sockets, accepts two riders "simultaneously"
    if :ets.insert_new(:rides_by_user, [{rider_id, :pending}, {driver_id, :pending}]) do
      # a claimed seat (even :pending) means "in a ride": no more map for either
      Hoodride.Roles.changed(rider_id)
      Hoodride.Roles.changed(driver_id)
      id = "r" <> Integer.to_string(System.unique_integer([:positive]))

      case DynamicSupervisor.start_child(
             Hoodride.Rides.Supervisor,
             {Hoodride.Rides.Ride, %{id: id, rider: rider_id, driver: driver_id}}
           ) do
        {:ok, _pid} ->
          {:ok, id}

        error ->
          :ets.delete(:rides_by_user, rider_id)
          :ets.delete(:rides_by_user, driver_id)
          Hoodride.Roles.changed(rider_id)
          Hoodride.Roles.changed(driver_id)
          error
      end
    else
      {:error, :busy}
    end
  end

  def get(id), do: call(id, :get_state) |> wrap_get()

  defp wrap_get({:error, :gone}), do: {:error, :gone}
  defp wrap_get(state), do: {:ok, state}

  def ride_id_of_user(user_id) do
    case :ets.lookup(:rides_by_user, user_id) do
      [{_, ride_id}] -> ride_id
      [] -> nil
    end
  end

  def set_pin(id, user_id, pin), do: call(id, {:set_pin, user_id, pin})
  def end_ride(id, user_id), do: call(id, {:end_ride, user_id})
  def arrived(id, user_id), do: call(id, {:arrived, user_id})

  @doc """
  A ride position from `user_id`: kept as their LAST one (for a partner who
  rejoins — `peer_position/2`) and stamped as activity. Synchronous, so the
  channel stores BEFORE it forwards: a joiner is never handed a position
  older than one already sent past it. `:ok`, or `{:error, :gone}`.
  """
  def position(id, user_id, %{lat: _, lng: _} = pos), do: call(id, {:position, user_id, pos})

  @doc """
  The PARTNER's last position for `user_id` in ride `id` — `%{from, lat, lng,
  age_ms}` — or nil (none yet, not in this ride, or the ride is gone).
  """
  def peer_position(id, user_id) do
    case call(id, {:peer_position, user_id}) do
      %{} = p -> p
      _ -> nil
    end
  end

  defp call(id, msg) do
    case Registry.lookup(Hoodride.Rides.Registry, id) do
      [{pid, _}] ->
        # the process can die between lookup and call — that's still "gone"
        try do
          GenServer.call(pid, msg)
        catch
          :exit, _ -> {:error, :gone}
        end

      [] ->
        {:error, :gone}
    end
  end
end

defmodule Hoodride.Rides.Positions do
  @moduledoc """
  Each person's last ride position, user_id => {lat, lng, at_ms}, in a
  wrapper that never prints. A crash report shows a callback's arguments —
  the WHOLE state — when no clause matches (format_status can't reach the
  stack trace, and the sensitive flag didn't hide it: tested). Wrapped, any
  inspect of the state — a stack trace, :sys.get_state, a debugger — shows
  `#Positions<redacted>` (the Erlang Ecosystem Foundation's advice: wrap
  secrets so introspection can't read them).
  """
  defstruct map: %{}

  defimpl Inspect do
    def inspect(_positions, _opts), do: "#Positions<redacted>"
  end
end

defmodule Hoodride.Rides.Ride do
  @moduledoc "A living ride. Born at accept, dies at end — the death IS the deletion."
  use GenServer, restart: :temporary

  @abandoned_after 30 * 60
  @check_every 60_000

  def start_link(args) do
    GenServer.start_link(__MODULE__, args, name: via(args.id))
  end

  defp via(id), do: {:via, Registry, {Hoodride.Rides.Registry, id}}

  alias Hoodride.Rides.Positions

  @impl true
  def init(%{id: id, rider: rider, driver: driver}) do
    # who's who, FIRST — before anything is cancelled, moved or announced: a
    # partner that doesn't exist stops the ride here, cleanly (start_ride
    # frees the seats). A database that can't answer (overload) shows
    # "Neighbor" instead, so the ride still starts and BOTH are told.
    case {peer_of(rider, :rider), peer_of(driver, :driver)} do
      {{rider_peer, rider_known}, {driver_peer, driver_known}} ->
        # whose name couldn't be looked up: asked again once the ride runs
        unnamed = for {uid, :unnamed} <- [{rider, rider_known}, {driver, driver_known}], do: uid
        start(id, rider, driver, %{rider => driver_peer, driver => rider_peer}, unnamed)

      _ ->
        {:stop, :no_such_user}
    end
  end

  defp peer_of(user_id, seat) do
    case Hoodride.Accounts.profile(user_id) do
      %{} = p -> {person(p, seat), :named}
      nil -> nil
      {:error, :unavailable} -> {%{id: user_id, name: "Neighbor", photo: nil}, :unnamed}
    end
  end

  # the DRIVER's side carries their car — what the rider looks for at
  # pickup ("Gray Honda Civic", or nil); the rider's side never does
  # (ARCHITECTURE.md "Your car")
  defp person(p, :driver),
    do: %{
      id: p.id,
      name: p.name,
      photo: p.photo,
      car: Hoodride.Accounts.car_label(p),
      car_parts: Hoodride.Accounts.car_parts(p)
    }

  defp person(p, :rider), do: %{id: p.id, name: p.name, photo: p.photo}

  @doc """
  The wait before asking for a name the ride started without: the database
  pool's own patience (Hoodride.Accounts.retry_wait_ms/0), doubling, at most
  30 s — for as long as the ride lasts.
  """
  def name_retry_ms(attempt),
    do: min(Hoodride.Accounts.retry_wait_ms() * 2 ** (attempt - 1), 30_000)

  defp start(id, rider, driver, peers, unnamed) do
    now = System.system_time(:second)
    :ets.insert(:rides_by_user, [{rider, id}, {driver, id}])

    # your ride starting withdraws any outstanding ask you had elsewhere
    # (found by the invariant fuzzer: mutual requests + accept left a live
    # outgoing request from someone already mid-ride) — withdrawn FIRST so
    # your own asks read "cancelled", before the decline sweep below
    Hoodride.Requests.cancel(rider)
    Hoodride.Requests.cancel(driver)
    # BOTH participants leave the browse map entirely — cars AND hands,
    # whichever seat you're in. Mid-ride means unavailable (waiters declined)
    # and invisible (no ghost 🚗 or ✋ from a lost mode-flip survives this).
    # Its answer isn't needed — the request lands either way, and the writer
    # itself keeps anyone in a ride off the map — so a short wait: a ride
    # starts within seconds even when the server is overloaded
    # (GeoWriter.exec)
    t = Application.get_env(:hoodride, :ride_geo_timeout, 1_000)
    Hoodride.Geo.driver_offline(driver, t)
    Hoodride.Geo.driver_offline(rider, t)
    Hoodride.Geo.hand_down(rider, t)
    Hoodride.Geo.hand_down(driver, t)

    # the pair's chat exists from the ride's first moment, BEFORE either app
    # hears ride_started: the first mid-ride message ("I'm the gray Honda")
    # is never a cold contact, and a silent ride stays reachable afterwards
    Hoodride.Chat.open(rider, driver)

    for {uid, role} <- [{rider, "rider"}, {driver, "driver"}] do
      # looked up before anything happened (init): no failure can stop this
      # loop half-way — before, a lookup failing on the SECOND person crashed
      # init after the first was already told "ride started"
      HoodrideWeb.Endpoint.broadcast("user:#{uid}", "ride_started", %{
        ride_id: id,
        role: role,
        peer: Map.fetch!(peers, uid)
      })
    end

    Process.send_after(self(), :check_abandoned, @check_every)
    if unnamed != [], do: Process.send_after(self(), {:name_retry, 1}, name_retry_ms(1))

    # from here on it holds both people's exact positions: no tracing, no
    # reading its message queue, no stack back-traces, left out of crash
    # dumps. Set at the END of start-up — no position exists before — so the
    # start-up itself stays traceable (contact_privacy_test traces it).
    Process.flag(:sensitive, true)

    {:ok,
     %{
       id: id,
       rider: rider,
       driver: driver,
       pin: nil,
       arrived: false,
       last_rider: now,
       last_driver: now,
       # each person's LAST ride position, for a partner who rejoins. Memory
       # only, gone with this process, never printed (Hoodride.Rides.Positions)
       positions: %Positions{},
       # people shown as "Neighbor" (their lookup failed at the start): the
       # real name follows on the ride channel once the database answers
       unnamed: unnamed
     }}
  end

  @impl true
  def handle_call(:get_state, _from, state) do
    {:reply, Map.take(state, [:id, :rider, :driver, :pin, :arrived]), state}
  end

  # only the driver declares arrival (their phone judges its own position,
  # or they tap "I'm here") — announced to both parties
  def handle_call({:arrived, user_id}, _from, %{driver: driver} = state)
      when user_id == driver do
    unless state.arrived, do: broadcast(state.id, "arrived", %{})
    {:reply, :ok, %{state | arrived: true} |> stamp(user_id)}
  end

  def handle_call({:arrived, _user_id}, _from, state),
    do: {:reply, {:error, :not_driver}, state}

  # only the rider places the meetup pin
  def handle_call({:set_pin, user_id, pin}, _from, %{rider: rider} = state)
      when user_id == rider do
    broadcast(state.id, "pin", %{pin: pin})
    {:reply, :ok, %{state | pin: pin} |> stamp(user_id)}
  end

  def handle_call({:set_pin, _user_id, _pin}, _from, state),
    do: {:reply, {:error, :not_rider}, state}

  def handle_call({:end_ride, user_id}, _from, state)
      when user_id in [state.rider, state.driver] do
    # seats are freed BEFORE anyone hears "ended" — so an immediate
    # re-request after the broadcast can never hit a stale busy-check
    free_seats(state)
    broadcast(state.id, "ended", %{by: user_id})
    {:stop, :normal, :ok, state}
  end

  def handle_call({:end_ride, _}, _from, state), do: {:reply, {:error, :not_yours}, state}

  def handle_call({:position, user_id, %{lat: lat, lng: lng}}, _from, state)
      when user_id in [state.rider, state.driver] do
    %Positions{map: map} = state.positions
    at = System.monotonic_time(:millisecond)
    state = %{state | positions: %Positions{map: Map.put(map, user_id, {lat, lng, at})}}
    {:reply, :ok, stamp(state, user_id)}
  end

  def handle_call({:position, _user_id, _pos}, _from, state),
    do: {:reply, {:error, :not_yours}, state}

  def handle_call({:peer_position, user_id}, _from, state)
      when user_id in [state.rider, state.driver] do
    partner = if user_id == state.rider, do: state.driver, else: state.rider

    %Positions{map: map} = state.positions

    reply =
      case map do
        %{^partner => {lat, lng, at}} ->
          %{from: partner, lat: lat, lng: lng, age_ms: System.monotonic_time(:millisecond) - at}

        _ ->
          nil
      end

    {:reply, reply, state}
  end

  def handle_call({:peer_position, _user_id}, _from, state), do: {:reply, nil, state}

  # anything else is refused or ignored, never a crash: a callback with no
  # matching clause prints its arguments — this message and the state
  def handle_call(_unknown, _from, state), do: {:reply, {:error, :bad_request}, state}

  # A crash report must not carry anyone's position (Erlang's format_status:
  # the state, the message that crashed it, the sys log). Ids, the pin's
  # presence and the reason stay: enough to debug.
  @impl true
  def format_status(status) do
    status
    |> Map.update(:state, nil, &redact_state/1)
    |> Map.update(:message, nil, fn _ -> :redacted end)
    |> Map.update(:log, [], fn log -> Enum.map(log, fn _ -> :redacted end) end)
  end

  defp redact_state(%{positions: %Positions{map: map}} = state),
    do: %{state | positions: Map.new(map, fn {uid, _} -> {uid, :redacted} end)}

  defp redact_state(other), do: other

  @impl true
  def handle_info(:check_abandoned, state) do
    now = System.system_time(:second)

    if now - state.last_rider > @abandoned_after and now - state.last_driver > @abandoned_after do
      free_seats(state)
      broadcast(state.id, "ended", %{by: nil, reason: "abandoned"})
      {:stop, :normal, state}
    else
      Process.send_after(self(), :check_abandoned, @check_every)
      {:noreply, state}
    end
  end

  # "Neighbor" used to stay for the whole ride (only a reload fixed it):
  # ask again; tell the ride channel ("peer") once the name is known; an
  # account gone meanwhile is simply dropped
  def handle_info({:name_retry, attempt}, state) do
    still =
      Enum.filter(state.unnamed, fn uid ->
        case Hoodride.Accounts.profile(uid) do
          %{} = p ->
            broadcast(
              state.id,
              "peer",
              person(p, if(uid == state.driver, do: :driver, else: :rider))
            )

            false

          nil ->
            false

          {:error, :unavailable} ->
            true
        end
      end)

    if still != [],
      do: Process.send_after(self(), {:name_retry, attempt + 1}, name_retry_ms(attempt + 1))

    {:noreply, %{state | unnamed: still}}
  end

  def handle_info(_unknown, state), do: {:noreply, state}

  @impl true
  def handle_cast(_unknown, state), do: {:noreply, state}

  # safety net for abnormal exits; idempotent with the eager free in end_ride.
  # A NORMAL stop (end_ride, abandoned) already announced "ended"; any other
  # exit (a crash) must announce it here, or both apps sit on a dead ride.
  @impl true
  def terminate(reason, state) do
    free_seats(state)

    unless reason == :normal or reason == :shutdown or match?({:shutdown, _}, reason) do
      broadcast(state.id, "ended", %{by: nil, reason: "error"})
    end

    :ok
  end

  # only the seats that still point at THIS ride (an exact-row delete): it
  # runs twice per end (end_ride, then terminate/2), and seats are keyed by
  # person — deleting by key erased a NEWER ride's seats had either person
  # started one in between (RideServerTest, found in the race audit)
  defp free_seats(state) do
    :ets.delete_object(:rides_by_user, {state.rider, state.id})
    :ets.delete_object(:rides_by_user, {state.driver, state.id})
    Hoodride.Roles.changed(state.rider)
    Hoodride.Roles.changed(state.driver)
  end

  defp stamp(state, user_id) do
    now = System.system_time(:second)

    cond do
      user_id == state.rider -> %{state | last_rider: now}
      user_id == state.driver -> %{state | last_driver: now}
      true -> state
    end
  end

  defp broadcast(id, event, payload) do
    HoodrideWeb.Endpoint.broadcast("ride:" <> id, event, payload)
  end
end
