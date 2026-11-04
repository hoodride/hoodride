defmodule HoodrideWeb.ContactFuzzTest do
  @moduledoc """
  Who can reach whom, under random traffic, checked against a tiny MODEL of
  the rule. Five apps move their maps, go online and offline, raise hands,
  start and end rides, request and cancel, and message each other. Before
  every message the model predicts the server's answer from the plain facts:

    relation (chat or open request)                 → sent
    a car on my screen (my map holds its car hex)   → sent
    I'm an online driver, a hand on my screen       → sent
    I'm a viewer, the car is online but off screen  → out_of_view
    anything else                                   → unavailable

  and the actual answer must match, every time. "On my screen" comes from
  what the app last asked to watch and its live role, not from the
  server's own bookkeeping. Rate limits are reset between steps: this test
  is about WHO, abuse_limits_test is about HOW OFTEN. Seeded; the seed is in
  any failure.
  """
  use ExUnit.Case

  alias Hoodride.{Chat, Geo, Requests, Rides, Roles, TestClient}
  import TestClient, only: [request: 4]

  @cells ["cf1", "cf2", "cf3"]
  @steps 400

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  defp pick(list), do: Enum.at(list, :rand.uniform(length(list)) - 1)
  defp prof(u), do: %{id: u.id, name: u.name, photo: nil}

  defp reset_limits(clients) do
    :ets.delete_all_objects(Hoodride.RateLimit)

    # the per-user budgets (Hoodride.RateBudget)
    for c <- clients, budget <- [:sync, :events] do
      :ets.delete(:rate_budgets, {budget, c.user.id})
    end
  end

  # What the real app does after anything happens: told its role changed
  # (the server dropped the layer it may no longer see), it sends the same
  # wish again, which brings the new role's layer. Without this a role
  # change would leave the map watching nothing, which the app never does.
  defp act_like_the_app(w) do
    reset_limits(w.clients)

    for c <- w.clients, Enum.any?(TestClient.frames(c), &match?({"role", _}, &1)) do
      cells = Map.get(w.watched, c.user.id, MapSet.new()) |> MapSet.to_list()
      {:ok, _} = request(c, "world", "sync", %{"geo" => cells})
    end
  end

  # ---- the model ----

  # → {expected answer, which case of the rule decided it}
  defp expected(me, other, watched) do
    car_cell = Geo.driver_cell(other.id)
    hand_cell = Geo.hand_cell(other.id)
    my_role = Roles.of(me.id)
    mine = Map.get(watched, me.id, MapSet.new())

    my_ride = Rides.ride_id_of_user(me.id)

    cond do
      me.id == other.id ->
        {{:error, "self"}, :self}

      # the spec, known independently of the chat table: ride partners can
      # always reach each other (the server must have opened their chat)
      my_ride not in [nil, :pending] and my_ride == Rides.ride_id_of_user(other.id) ->
        {:ok, :ride_partner}

      Chat.exists?(me.id, other.id) or Requests.open_between?(me.id, other.id) ->
        {:ok, :relation}

      car_cell && my_role == :viewer && MapSet.member?(mine, car_cell) ->
        {:ok, :car_on_screen}

      car_cell && my_role == :viewer ->
        {{:error, "out_of_view"}, :out_of_view}

      hand_cell && my_role == :driver && MapSet.member?(mine, hand_cell) ->
        {:ok, :hand_on_screen}

      true ->
        {{:error, "unavailable"}, :unavailable}
    end
  end

  defp outcome({:ok, _}), do: :ok
  defp outcome({:error, %{reason: r}}), do: {:error, r}

  # ---- random actions; each returns the updated world ----

  defp step(:watch, w) do
    c = pick(w.clients)
    # a real screen covers the whole area most of the time
    cells =
      if :rand.uniform(3) > 1,
        do: @cells,
        else: Enum.filter(@cells, fn _ -> :rand.uniform(2) == 1 end)

    {:ok, _} = request(c, "world", "sync", %{"geo" => cells})
    %{w | watched: Map.put(w.watched, c.user.id, MapSet.new(cells))}
  end

  defp step(:drive, w) do
    Geo.driver_update(prof(pick(w.users)), pick(@cells), nil)
    w
  end

  defp step(:offline, w) do
    Geo.driver_offline(pick(w.users).id)
    w
  end

  defp step(:hand, w) do
    Geo.hand_up(pick(w.users).id, pick(@cells), "s")
    w
  end

  defp step(:lower, w) do
    Geo.hand_down(pick(w.users).id)
    w
  end

  defp step(:ask, w) do
    {r, d} = {pick(w.users), pick(w.users)}
    _ = Requests.create(r, d.id)
    w
  end

  # a conversation dies the way the sweeper lets it (its room empty: no
  # shared ride, no open request — presence aside), so pairs keep turning
  # back into strangers and cold contacts stay common; every sent message
  # creates one, and relations would otherwise take over. A ride's chat is
  # never a candidate, exactly as in Sweeper.sweep_empty_room_chats.
  defp step(:forget, w) do
    deletable =
      for {{a, b} = key, _} <- Chat.all_conversations(),
          not same_ride?(a, b),
          not Requests.open_between?(a, b),
          do: key

    if deletable != [], do: Chat.delete_conversation(pick(deletable))
    w
  end

  defp step(:cancel, w) do
    Requests.cancel(pick(w.users).id)
    w
  end

  defp step(:ride, w) do
    case Enum.filter(w.users, &(Rides.ride_id_of_user(&1.id) == nil)) |> Enum.shuffle() do
      [a, b | _] ->
        {:ok, ride} = Rides.start_ride(a.id, b.id)
        %{w | rides: [{ride, a.id} | w.rides]}

      _ ->
        w
    end
  end

  defp step(:end_ride, %{rides: []} = w), do: w

  defp step(:end_ride, w) do
    {ride, by} = pick(w.rides)
    Rides.end_ride(ride, by)
    %{w | rides: List.delete(w.rides, {ride, by})}
  end

  # the action under test: the model predicts, the server answers
  defp step(:message, w), do: message(w, pick(w.clients), pick(w.users))

  # targeted: someone the model says is on this app's screen, if anyone is
  # (cold contacts that SHOULD go through are rare by chance — this makes
  # sure that side of the rule is exercised every run)
  defp step(:message_on_screen, w) do
    pairs =
      for c <- w.clients,
          o <- w.users,
          elem(expected(c.user, o, w.watched), 1) in [:car_on_screen, :hand_on_screen],
          do: {c, o}

    case pairs do
      [] -> w
      _ -> (fn {c, o} -> message(w, c, o) end).(pick(pairs))
    end
  end

  # STAGED: set up one of the rare situations on purpose, then message.
  # The model still predicts the answer on its own, so this only makes sure
  # every case of the rule happens in every run (by chance, an online driver
  # watching the very hex a hand is raised in was ~1 run in 70).
  @kinds [:ride_partner, :relation, :car_on_screen, :hand_on_screen, :out_of_view, :unavailable]
  # staged situations → the model case each must land in
  @stages Map.new(@kinds, &{&1, &1}) |> Map.put(:driver_to_car, :unavailable)

  defp step(:stage, w), do: stage(pick(Map.keys(@stages)), w)

  # Build the exact situation for one case of the rule between two apps, then
  # message. Both are first taken out of any ride and made strangers (no
  # chat, no request) so nothing but the staged facts decides the answer.
  defp stage(kind, w) do
    w = Enum.reduce(w.rides, w, fn _, w -> step(:end_ride, w) end)
    [c, o] = Enum.take_random(w.clients, 2)
    {me, them} = {c.user, o.user}

    Chat.delete_conversation(Chat.pair_key(me.id, them.id))
    Requests.cancel(me.id)
    Requests.cancel(them.id)
    for u <- [me, them], do: Geo.hand_down(u.id) && Geo.driver_offline(u.id)

    w =
      case kind do
        :relation ->
          Chat.send_message(prof(them), me.id, "hi")
          w

        :car_on_screen ->
          Geo.driver_update(prof(them), hd(@cells), nil)
          watch(w, c, @cells)

        :hand_on_screen ->
          Geo.driver_update(prof(me), "elsewhere", nil)
          Geo.hand_up(them.id, hd(@cells), "s")
          watch(w, c, @cells)

        :out_of_view ->
          Geo.driver_update(prof(them), List.last(@cells), nil)
          watch(w, c, [hd(@cells)])

        :unavailable ->
          watch(w, c, @cells)

        :driver_to_car ->
          # an online driver cold-messaging a car right on their screen
          Geo.driver_update(prof(me), hd(@cells), nil)
          Geo.driver_update(prof(them), hd(@cells), nil)
          watch(w, c, @cells)

        :ride_partner ->
          # a ride started the real way, with no message ever sent
          {:ok, ride} = Rides.start_ride(me.id, them.id)
          %{w | rides: [{ride, me.id} | w.rides]}
      end

    act_like_the_app(w)
    w = message(w, c, them)
    # the staged case must be the one the model saw (else the staging is wrong)
    assert w.last_kind == @stages[kind], "staged #{kind}, but the model saw #{w.last_kind}"
    w
  end

  defp watch(w, c, cells) do
    reset_limits(w.clients)
    {:ok, _} = request(c, "world", "sync", %{"geo" => cells})
    %{w | watched: Map.put(w.watched, c.user.id, MapSet.new(cells))}
  end

  defp message(w, c, other) do
    {want, kind} = expected(c.user, other, w.watched)
    got = request(c, "user:#{c.user.id}", "send_msg", %{"to" => other.id, "text" => "hi"})

    assert outcome(got) == want,
           "seed #{w.seed}, step #{w.n}: #{c.name} (#{Roles.of(c.user.id)}, watching " <>
             "#{inspect(MapSet.to_list(Map.get(w.watched, c.user.id, MapSet.new())))}) → " <>
             "#{other.name} (car #{inspect(Geo.driver_cell(other.id))}, hand " <>
             "#{inspect(Geo.hand_cell(other.id))}): expected #{inspect(want)}, got #{inspect(got)}"

    %{w | seen: Map.update(w.seen, kind, 1, &(&1 + 1)), last_kind: kind}
  end

  # messages twice as likely as any other action, so every state gets probed
  @actions ~w(watch drive offline hand lower ask cancel ride end_ride forget message message message_on_screen stage)a

  defp same_ride?(a, b) do
    ride = Rides.ride_id_of_user(a)
    ride != nil and ride == Rides.ride_id_of_user(b)
  end

  test "every message is accepted or refused exactly as the rule says" do
    seed = :erlang.phash2(make_ref())
    :rand.seed(:exsss, {seed, 3, 5})

    users = for i <- 1..5, do: user("cf-#{i}")
    clients = for {u, i} <- Enum.with_index(users), do: TestClient.start(:"cf#{i}", u)

    w0 = %{
      users: users,
      clients: clients,
      watched: %{},
      rides: [],
      seed: seed,
      n: 0,
      seen: %{},
      last_kind: nil
    }

    w =
      Enum.reduce(1..@steps, w0, fn n, w ->
        reset_limits(clients)
        w = step(pick(@actions), %{w | n: n})
        act_like_the_app(w)
        w
      end)

    # the guaranteed tour: every case of the rule staged three more times,
    # so coverage never depends on the seed (the random part explores, the
    # tour makes sure nothing went unprobed)
    w = Enum.reduce(for(k <- Map.keys(@stages), _ <- 1..3, do: k), w, &stage/2)

    for kind <- @kinds do
      assert Map.get(w.seen, kind, 0) >= 3,
             "seed #{seed}: too little coverage of #{kind}: #{inspect(w.seen)}"
    end
  end
end
