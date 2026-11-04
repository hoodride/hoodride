defmodule Hoodride.TestClient do
  @moduledoc """
  One simulated app per process.

  Phoenix.ChannelTest delivers every joined channel's pushes to the process
  that joined it. Two clients joined from the test process would share one
  mailbox, and a refute_push could not tell the rider's "world" from the
  driver's — a privacy test could pass or fail for the wrong reason. Each
  client here joins from its OWN process and relays everything it receives
  to the test, tagged with the client's name.

  Ordering: a channel pushes to its client in mailbox order, so once the
  reply to a later request arrives, every push that channel made before it
  has already been relayed. `frames/2` uses that as its barrier.
  """
  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  defstruct [:name, :pid, :user]

  @doc """
  Connect `user` and join `topics` (default: the world and the user's own
  channel). `raw: pid` also sends every message, exactly as the channel
  pushed it, to `pid` as `{name, :raw, message}` (byte-level wire tests).
  """
  def start(name, user, topics \\ nil, opts \\ []) do
    test = self()
    topics = topics || ["world", "user:#{user.id}"]
    raw = Keyword.get(opts, :raw)
    pid = spawn_link(fn -> init(test, name, user, topics, raw) end)

    receive do
      {^name, :ready} ->
        %__MODULE__{name: name, pid: pid, user: user}

      {^name, :join_failed, topic, reason} ->
        raise "#{name} couldn't join #{topic}: #{inspect(reason)}"
    after
      2_000 -> raise "client #{name} didn't start"
    end
  end

  defp init(test, name, user, topics, raw) do
    Process.put(:raw, raw)
    Process.flag(:trap_exit, true)

    # test_process: the channels hang off the TEST's supervisor (cleaned up
    # with the test) while their pushes come to this process
    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)},
        test_process: test
      )

    chans =
      Enum.reduce_while(topics, %{}, fn topic, acc ->
        case join(socket, topic, %{}) do
          {:ok, _reply, chan} ->
            {:cont, Map.put(acc, topic, chan)}

          {:error, reason} ->
            send(test, {name, :join_failed, topic, reason})
            {:halt, :failed}
        end
      end)

    if chans != :failed do
      send(test, {name, :ready})
      loop(test, name, socket, chans)
    end
  end

  defp loop(test, name, socket, chans) do
    receive do
      {:push, from, topic, event, payload} ->
        ref = push(Map.fetch!(chans, topic), event, payload)
        send(from, {name, :pushed, ref})
        loop(test, name, socket, chans)

      {:join, from, topic} ->
        result = join(socket, topic, %{})
        chans = with {:ok, _, chan} <- result, do: Map.put(chans, topic, chan), else: (_ -> chans)
        send(from, {name, :joined, topic, elem(result, 0)})
        loop(test, name, socket, chans)

      {:channel_pid, from, topic} ->
        send(from, {name, :channel_pid, Map.fetch!(chans, topic).channel_pid})
        loop(test, name, socket, chans)

      :stop ->
        :ok

      other ->
        if raw = Process.get(:raw), do: send(raw, {name, :raw, other})
        send(test, {name, :got, plain(other)})
        loop(test, name, socket, chans)
    end
  end

  # a map batch's items arrive pre-encoded (each update encoded once by the
  # map writer — Hoodride.Geo): tests compare plain values, so decode them
  defp plain(%Phoenix.Socket.Message{event: "batch", payload: %{items: items}} = m),
    do: %{m | payload: %{items: Enum.map(items, fn [e, p] -> [e, decoded(p)] end)}}

  defp plain(other), do: other

  defp decoded(%Jason.Fragment{encode: encode}),
    do: encode.(nil) |> IO.iodata_to_binary() |> Jason.decode!(keys: :atoms)

  defp decoded(p), do: p

  @doc "Push an event on `topic` and wait for its reply: {status, payload}."
  def request(%__MODULE__{name: name, pid: pid}, topic, event, payload \\ %{}) do
    send(pid, {:push, self(), topic, event, payload})

    ref =
      receive do
        {^name, :pushed, ref} -> ref
      after
        1_000 -> raise "#{name} didn't push #{event}"
      end

    receive do
      {^name, :got, %Phoenix.Socket.Reply{ref: ^ref, status: status, payload: reply}} ->
        {status, reply}
    after
      2_000 -> raise "#{name} got no reply to #{event}"
    end
  end

  @doc "The channel process behind `topic` (to suspend it in race tests)."
  def channel_pid(%__MODULE__{name: name, pid: pid}, topic \\ "world") do
    send(pid, {:channel_pid, self(), topic})

    receive do
      {^name, :channel_pid, chan_pid} -> chan_pid
    after
      1_000 -> raise "#{name} has no #{topic} channel"
    end
  end

  @doc """
  Asserts the map channel's ACTUAL PubSub subscriptions are exactly what it
  believes it holds (plus its own role topic). A channel that updated its
  record but forgot to unsubscribe would still receive every message of the
  old layer — dropped by the live-role check, so nothing leaks to the app,
  which is exactly why only this comparison can see it.
  """
  def assert_subscriptions_match(%__MODULE__{} = client) do
    pid = channel_pid(client)
    held = :sys.get_state(pid).assigns.held
    actual = Registry.keys(Hoodride.PubSub, pid) |> MapSet.new()
    # plus its role topic, and "world": Phoenix subscribes every channel to
    # its own topic (nothing in the app ever broadcasts to "world")
    expected = held |> MapSet.put(Hoodride.Roles.topic(client.user.id)) |> MapSet.put("world")

    unless actual == expected do
      raise ExUnit.AssertionError,
        message:
          "#{client.name}: subscribed to #{inspect(MapSet.to_list(actual))} " <>
            "but holds #{inspect(MapSet.to_list(expected))} " <>
            "(extra: #{inspect(MapSet.to_list(MapSet.difference(actual, expected)))}, " <>
            "missing: #{inspect(MapSet.to_list(MapSet.difference(expected, actual)))})"
    end

    :ok
  end

  @doc "Join one more topic later (e.g. a ride channel)."
  def join_topic(%__MODULE__{name: name, pid: pid}, topic) do
    send(pid, {:join, self(), topic})

    receive do
      {^name, :joined, ^topic, status} -> status
    after
      1_000 -> raise "#{name} didn't join #{topic}"
    end
  end

  @doc """
  Every push `client` received on `topic` up to now, as [{event, payload}],
  in order. A world-channel request makes the barrier: the channel answers
  it only after pushing everything queued before it. Frames of other topics
  stay in the mailbox.
  """
  def frames(%__MODULE__{} = client, topic \\ "world") do
    # an event nothing handles: refused (never a crash), but answered in order
    _ = request(client, topic, "__barrier__", %{})
    collect(client.name, topic, [])
  end

  defp collect(name, topic, acc) do
    receive do
      # a map batch (WorldChannel :map_batch_ms) reads as its items, in order
      {^name, :got,
       %Phoenix.Socket.Message{topic: ^topic, event: "batch", payload: %{items: items}}} ->
        collect(name, topic, Enum.reverse(for([e, p] <- items, do: {e, p}), acc))

      {^name, :got, %Phoenix.Socket.Message{topic: ^topic, event: event, payload: payload}} ->
        collect(name, topic, [{event, payload} | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  @doc "The events (names only) among `frames`."
  def events(frames), do: Enum.map(frames, &elem(&1, 0))
end
