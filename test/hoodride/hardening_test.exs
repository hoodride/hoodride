defmodule Hoodride.HardeningTest do
  @moduledoc """
  Crash hardening (owner, 2026-11-13; crash review 2026-11-12). No known
  input triggers these today — they keep a future bug from spreading:

    * a message nobody expected (a stray reply, a leftover timer) is
      ignored by every long-lived process, never a crash: a user's
      connection, a ride's, the cleanup (Sweeper), the map writer;
    * a map update that fails inside the writer fails ALONE: the writer
      keeps running (its other callers' updates still land), its caller
      gets an error instead of crashing with it — and repeated failures
      can't add up to restarting the whole app.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  import ExUnit.CaptureLog
  @endpoint HoodrideWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    users =
      for k <- ["hd-a", "hd-b"] do
        {:ok, u} =
          Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: k, name: k})

        u
      end

    %{users: users}
  end

  defp connect_as(user) do
    {:ok, s} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    s
  end

  defp junk, do: {:not_expected, make_ref(), "anything"}

  describe "a message nobody expected is ignored" do
    test "a user's connection", %{users: [a, _]} do
      {:ok, _, chan} = subscribe_and_join(connect_as(a), "user:#{a.id}", %{})
      send(chan.channel_pid, junk())
      ref = push(chan, "made_up_event", %{})
      assert_reply ref, :error, %{reason: "bad_request"}
    end

    test "a ride's connection", %{users: [a, b]} do
      {:ok, ride_id} = Hoodride.Rides.start_ride(a.id, b.id)
      {:ok, _, ride} = subscribe_and_join(connect_as(a), "ride:#{ride_id}", %{})
      send(ride.channel_pid, junk())
      ref = push(ride, "made_up_event", %{})
      assert_reply ref, :error, %{reason: "bad_request"}
    end

    test "the cleanup (Sweeper)" do
      pid = Process.whereis(Hoodride.Sweeper)
      send(pid, junk())
      _ = :sys.get_state(pid)
      assert Process.whereis(Hoodride.Sweeper) == pid
    end

    test "the map writer" do
      pid = GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, 1}})
      send(pid, junk())
      _ = :sys.get_state(pid)
      assert GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, 1}}) == pid
    end
  end

  # all the writers share ONE supervisor, whose default allowance is 3
  # restarts in 5 s for all of them together — then it gives up, and the
  # top supervisor's own 3-in-5 s soon restarts the whole app (supervision
  # review 2026-11-13). A few writers dying in a row must not do that.
  test "ten writer restarts in a row: their supervisor carries on" do
    sup = Process.whereis(Hoodride.GeoWriters)

    for i <- 1..10 do
      w = GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, i}})
      ref = Process.monitor(w)
      Process.exit(w, :kill)
      assert_receive {:DOWN, ^ref, :process, ^w, :killed}
      # (back: a new one, answering)
      _ = :sys.get_state(replaced(i, w))
    end

    assert Process.whereis(Hoodride.GeoWriters) == sup
  end

  # the writer for key `i` once it's a new process (the lookup can name the
  # old one for a moment after it died)
  defp replaced(i, old, tries \\ 200) do
    case GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, i}}) do
      pid when is_pid(pid) and pid != old ->
        pid

      _ when tries > 0 ->
        Process.sleep(5)
        replaced(i, old, tries - 1)

      other ->
        flunk("no new writer for #{i}: #{inspect(other)}")
    end
  end

  describe "a map update that fails inside the writer" do
    test "fails alone: the writer keeps running, its caller gets an error, the next update lands",
         %{users: [a, _]} do
      writer = GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, a.id}})

      # (parents that aren't a list: no caller sends that — a stand-in for a bug)
      log =
        capture_log(fn ->
          assert {:error, :failed} = Hoodride.Geo.hand_up(a.id, "cHd", nil, :not_a_list)
        end)

      assert log =~ "map update failed"
      assert GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, a.id}}) == writer

      assert :ok = Hoodride.Geo.hand_up(a.id, "cHd", nil, [])
      assert Hoodride.Geo.hand_cell(a.id) == "cHd"
    end

    test "a writer that's gone: the caller gets an error, never crashes with it" do
      gone = spawn(fn -> :ok end)
      ref = Process.monitor(gone)
      assert_receive {:DOWN, ^ref, :process, ^gone, _}
      assert {:error, :unavailable} = Hoodride.GeoWriter.call(gone, {:hand_down, 1}, 1_000)
    end
  end
end
