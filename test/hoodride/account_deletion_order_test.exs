defmodule Hoodride.AccountDeletionOrderTest do
  @moduledoc """
  Deleting an account shuts it down BEFORE its row (and blocks) leave the
  database (sixteenth review, 2026-11-19 — owner: go). It erased first and
  tore down after, and in between:

    * someone who blocked it, loading their blocks, read "not blocked" (the
      database had none left) and saw its car or ✋;
    * a car update already on its way from its phone put the car back
      after it was taken off the map;
    * a backed-up map writer timed the removal out — the blocks were
      forgotten while the car was still there.

  Now: signed out (database and memory), its connections closed (waited
  for), off the map (waited for, however busy the writers), THEN the
  erase. Signed out first means a failed erase leaves the account intact
  but signed out (the owner's choice).
  """
  use Hoodride.DataCase, async: false

  alias Hoodride.{Accounts, AccountDeletion, Blocks, Geo}
  alias Hoodride.TestHelpers

  setup do
    TestHelpers.scrub_live_state()

    on_exit(fn ->
      Application.delete_env(:hoodride, :account_deletion_hook)
      Application.delete_env(:hoodride, :geo_call_timeout)
      Application.delete_env(:hoodride, :deletion_off_map_wait_ms)
    end)

    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp drive(id, cell \\ "doC") do
    Geo.user_connected(id)
    Geo.driver_update(%{id: id, name: "D", photo: nil}, cell, cell <> "-s", [])
  end

  defp at(step, fun) do
    Application.put_env(:hoodride, :account_deletion_hook, fn
      ^step -> fun.()
      _ -> :ok
    end)
  end

  test "when the row is erased, the account is already off the map and signed out" do
    [ann, bob] = [user("do-ann"), user("do-bob")]
    :ok = Blocks.block(bob.id, ann.id)
    {:ok, _} = Hoodride.SessionTokens.create(ann.id)
    drive(ann.id)
    Geo.hand_up(user("do-cat").id, "doC", "doC-h", [])
    me = self()

    at(:erasing, fn ->
      send(me, {:at_erase, Geo.driver_on_map?(ann.id), Hoodride.SessionTokens.any?(ann.id)})
    end)

    assert :ok = AccountDeletion.delete(ann.id)
    assert_received {:at_erase, on_map?, signed_in?}
    refute on_map?, "the car still on the map when the row (and its blocks) were erased"
    refute signed_in?, "still signed in when the row was erased"
    refute Geo.driver_on_map?(ann.id)
  end

  # a connection of the account, sending car updates as fast as it can (as
  # an update already on its way would): the deletion waits for its
  # connections to close — none can put the car back after
  test "a connection still sending updates can't put the car back" do
    ann = user("du-ann")
    drive(ann.id)
    parent = self()

    sender =
      spawn(fn ->
        {:ok, _} = Registry.register(Hoodride.UserChannels, ann.id, self())
        send(parent, :registered)
        loop = fn loop -> drive(ann.id) && loop.(loop) end
        loop.(loop)
      end)

    assert_receive :registered
    ref = Process.monitor(sender)
    assert :ok = AccountDeletion.delete(ann.id)
    assert_received {:DOWN, ^ref, :process, ^sender, _}
    refute Geo.driver_on_map?(ann.id), "an update after the removal put the car back"
  end

  # the map writers backed up past the caller's wait: the removal is still
  # queued, and the deletion waits for it before going on
  test "a backed-up map writer: off the map before the erase all the same" do
    ann = user("dw-ann")
    drive(ann.id)
    Application.put_env(:hoodride, :geo_call_timeout, 20)
    me = self()

    holder =
      spawn(fn ->
        Geo.with_writers_held(fn _ ->
          send(me, :held)

          receive do
            :release -> :ok
          after
            1_000 -> :ok
          end
        end)
      end)

    assert_receive :held
    at(:erasing, fn -> send(me, {:at_erase, Geo.driver_on_map?(ann.id)}) end)
    Process.send_after(holder, :release, 300)
    assert :ok = AccountDeletion.delete(ann.id)
    assert_received {:at_erase, on_map?}
    refute on_map?, "erased while the car's removal still waited in a writer"
  end

  defp writer(id), do: GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, id}})

  # (seventeenth review, 2026-11-19: a wedged writer took the whole wait
  # on the car's removal — the ✋'s was never sent; and every timed-out
  # try queued another copy of the removal onto the wedged writer)
  test "a wedged map writer: the ✋'s removal is still queued — once, and lands on resume" do
    ann = user("dq-ann")
    Geo.user_connected(ann.id)
    Geo.hand_up(ann.id, "dqC", "dqC-h", [])
    Application.put_env(:hoodride, :deletion_off_map_wait_ms, 400)
    Application.put_env(:hoodride, :geo_call_timeout, 20)
    pid = writer(ann.id)
    :sys.suspend(pid)

    try do
      assert :ok = AccountDeletion.delete(ann.id)
      # (map changes only: another test's "release" can be waiting there too)
      {:messages, msgs} = Process.info(pid, :messages)
      queued = Enum.count(msgs, &match?({:"$gen_call", _, _}, &1))
      # each pass: the car's removal, the ✋'s, one "caught up?" — no copies
      assert queued <= 6, "#{queued} messages queued on the wedged writer"
    after
      :sys.resume(pid)
      :sys.get_state(pid)
    end

    assert Geo.hand_cell(ann.id) == nil, "the ✋ outlived the deleted account"
  end

  # (seventeenth review, 2026-11-19: the second pass signed out again in
  # the database — a busy database there failed it AFTER the erase, and
  # the rest (blocks, chats, presence) was skipped with a 500)
  test "after the erase: no sign-in write to the database (nothing there can fail it)" do
    ann = user("de-ann")
    {:ok, _} = Hoodride.SessionTokens.create(ann.id)
    me = self()
    erased = :atomics.new(1, [])
    at(:erasing, fn -> :atomics.put(erased, 1, 1) end)
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ ->
        if :atomics.get(erased, 1) == 1 and meta.query =~ "user_tokens",
          do: send(me, {:after_erase, meta.query})
      end,
      nil
    )

    try do
      assert :ok = AccountDeletion.delete(ann.id)
    after
      :telemetry.detach(id)
    end

    refute_received {:after_erase, _}, "a sign-in write after the erase"
  end

  # (eighteenth review, 2026-11-19: each message looked its writer up by
  # name — the removals queued on a writer that was then replaced (its
  # queue lost), "caught up?" asked the new one: "yes", nothing re-sent,
  # the ✋ left on the map)
  test "the map writer replaced with the removals in its queue: sent again" do
    ann = user("dr-ann")
    Geo.user_connected(ann.id)
    Geo.hand_up(ann.id, "drC", "drC-h", [])
    Application.put_env(:hoodride, :deletion_off_map_wait_ms, 2_000)
    old = writer(ann.id)
    :sys.suspend(old)
    {:ok, once} = Agent.start_link(fn -> true end)

    me = self()

    Application.put_env(:hoodride, :account_deletion_hook, fn
      :removals_sent ->
        if Agent.get_and_update(once, &{&1, false}) do
          # the removals queued on the suspended writer — it dies (its queue
          # lost) and its supervisor starts a new one
          ref = Process.monitor(old)
          Process.exit(old, :kill)
          receive do: ({:DOWN, ^ref, _, _, _} -> :ok)

          wait_new = fn wait_new ->
            if writer(ann.id) in [nil, old], do: wait_new.(wait_new), else: :ok
          end

          wait_new.(wait_new)
        end

      # (when the row goes: the ✋ must be gone already — the pass after the
      # erase would hide a loss here)
      :erasing ->
        send(me, {:at_erase, Geo.hand_cell(ann.id)})

      _ ->
        :ok
    end)

    assert :ok = AccountDeletion.delete(ann.id)
    assert_received {:at_erase, hand}

    assert hand == nil,
           "the ✋ still on the map at the erase: its removal was lost with the old writer"
  end

  # (twentieth review, 2026-11-19: with a wedged writer, both passes waited
  # the full time — past the app's 15 s request limit; the phone said
  # "couldn't reach" while the deletion went on. The pass after the erase
  # only catches a late sign-in: it waits a fifth as long)
  test "a wedged map writer: the whole deletion waits little more than one wait" do
    ann = user("dt-ann")
    Geo.user_connected(ann.id)
    Geo.hand_up(ann.id, "dtC", "dtC-h", [])
    Application.put_env(:hoodride, :deletion_off_map_wait_ms, 1_000)
    pid = writer(ann.id)
    :sys.suspend(pid)

    try do
      {us, :ok} = :timer.tc(fn -> AccountDeletion.delete(ann.id) end)
      assert div(us, 1000) < 1_600, "#{div(us, 1000)} ms — the full wait twice"
    after
      :sys.resume(pid)
      :sys.get_state(pid)
    end
  end

  test "the erase failing: nothing deleted, signed out and off the map (the owner's choice)" do
    ann = user("df-ann")
    {:ok, _} = Hoodride.SessionTokens.create(ann.id)
    drive(ann.id)

    Hoodride.Repo.query!(
      "CREATE TRIGGER refuse_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'refused'); END"
    )

    assert {:error, :failed_signed_out} = AccountDeletion.delete(ann.id)
    assert Accounts.get_user(ann.id), "the account is intact"
    refute Hoodride.SessionTokens.any?(ann.id)
    refute Geo.driver_on_map?(ann.id)
  end
end
