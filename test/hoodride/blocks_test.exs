defmodule Hoodride.BlocksTest do
  @moduledoc """
  Blocks (owner, 2026-11-15 — Hoodride.Blocks). Ann blocks Bob: either way,
  the two don't see each other on the map and can't message or ask each
  other for a ride. The database is the record (it survives a restart);
  memory holds the blocks of people in use, read from the database the
  first time they're needed — a person not in memory is never "not
  blocked", their rows are read first. At most 200 blocked people each,
  20 blocks or unblocks a day.
  """
  use Hoodride.DataCase, async: false

  alias Hoodride.{Accounts, Blocks, Repo}

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    on_exit(fn -> Application.delete_env(:hoodride, :blocks_hook) end)
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp rows, do: Repo.query!("SELECT blocker_id, blocked_id FROM blocks").rows

  # memory as after a restart: nothing loaded
  defp forget_memory, do: Blocks.reset_memory()

  describe "a block" do
    test "either way: neither sees the other; nobody else is touched" do
      [ann, bob, cat] = [user("bl-ann"), user("bl-bob"), user("bl-cat")]
      assert :ok = Blocks.block(ann.id, bob.id)
      assert Blocks.blocked?(ann.id, bob.id)
      assert Blocks.blocked?(bob.id, ann.id), "both ways"
      refute Blocks.blocked?(ann.id, cat.id)
      refute Blocks.blocked?(cat.id, bob.id)
      assert rows() == [[ann.id, bob.id]]
    end

    test "kept in the database: after a restart (memory empty) still blocked" do
      [ann, bob] = [user("bl2-ann"), user("bl2-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      forget_memory()
      assert Blocks.blocked?(bob.id, ann.id)
      assert Blocks.blocked?(ann.id, bob.id)
    end

    test "a person not in memory is read from the database — never 'not blocked'" do
      [ann, bob] = [user("bl3-ann"), user("bl3-bob")]
      # (written as another copy of the app, or before a restart, would have)
      now = System.system_time(:millisecond)

      Repo.query!("INSERT INTO blocks (blocker_id, blocked_id, inserted_at) VALUES (?, ?, ?)", [
        ann.id,
        bob.id,
        now
      ])

      forget_memory()
      assert Blocks.blocked?(bob.id, ann.id)
    end

    test "twice is once; yourself or nobody: refused" do
      [ann, bob] = [user("bl4-ann"), user("bl4-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      :ok = Blocks.block(ann.id, bob.id)
      assert length(rows()) == 1
      assert Blocks.block(ann.id, ann.id) == {:error, :self}
      assert Blocks.block(ann.id, 999_999_999_999) == {:error, :none}
    end

    test "a block made while memory was loaded is seen at once, both ways" do
      [ann, bob] = [user("bl5-ann"), user("bl5-bob")]
      refute Blocks.blocked?(ann.id, bob.id)
      refute Blocks.blocked?(bob.id, ann.id)
      :ok = Blocks.block(bob.id, ann.id)
      assert Blocks.blocked?(ann.id, bob.id)
      assert Blocks.blocked?(bob.id, ann.id)
    end
  end

  describe "unblocking" do
    test "by the one who blocked: they see each other again" do
      [ann, bob] = [user("ub-ann"), user("ub-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      assert :ok = Blocks.unblock(ann.id, bob.id)
      refute Blocks.blocked?(ann.id, bob.id)
      refute Blocks.blocked?(bob.id, ann.id)
      assert rows() == []
    end

    test "the blocked one can't undo it" do
      [ann, bob] = [user("ub2-ann"), user("ub2-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      assert Blocks.unblock(bob.id, ann.id) == {:error, :none}
      assert Blocks.blocked?(bob.id, ann.id)
    end

    test "each blocked the other: one unblocking leaves the other's block" do
      [ann, bob] = [user("ub3-ann"), user("ub3-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      :ok = Blocks.block(bob.id, ann.id)
      # (both in memory: the unblock must keep Bob's block there too)
      assert Blocks.blocked?(ann.id, bob.id) and Blocks.blocked?(bob.id, ann.id)
      :ok = Blocks.unblock(ann.id, bob.id)
      assert Blocks.blocked?(ann.id, bob.id)
      assert Blocks.blocked?(bob.id, ann.id)
    end
  end

  describe "the list" do
    test "who I blocked, newest first — not who blocked me" do
      [ann, bob, cat, dan] = [user("li-ann"), user("li-bob"), user("li-cat"), user("li-dan")]
      :ok = Blocks.block(ann.id, bob.id)
      :ok = Blocks.block(ann.id, cat.id)
      :ok = Blocks.block(dan.id, ann.id)
      # (the same millisecond: newest is the later one)
      assert Blocks.list(ann.id) == [cat.id, bob.id]
      assert Blocks.list(bob.id) == []
    end
  end

  describe "limits" do
    test "at most #{Hoodride.Limits.blocks_per_person()} blocked people each" do
      ann = user("lim-ann")
      max = Hoodride.Limits.blocks_per_person()
      now = System.system_time(:millisecond)

      # (the rest already there, as over days)
      for i <- 1..(max - 1) do
        u = user("lim-#{i}")

        Repo.query!("INSERT INTO blocks (blocker_id, blocked_id, inserted_at) VALUES (?, ?, ?)", [
          ann.id,
          u.id,
          now - i
        ])
      end

      assert :ok = Blocks.block(ann.id, user("lim-last").id)
      assert Blocks.block(ann.id, user("lim-over").id) == {:error, :full}
      # unblocking one makes room
      :ok = Blocks.unblock(ann.id, user("lim-last").id)
      assert :ok = Blocks.block(ann.id, user("lim-over").id)
    end

    test "#{Hoodride.Limits.block_actions_per_day()} blocks or unblocks a day, together; a refused one costs nothing" do
      ann = user("day-ann")
      n = Hoodride.Limits.block_actions_per_day()
      others = for i <- 1..n, do: user("day-#{i}")
      half = div(n, 2)

      for o <- Enum.take(others, n - half), do: :ok = Blocks.block(ann.id, o.id)
      for o <- Enum.take(others, half), do: :ok = Blocks.unblock(ann.id, o.id)

      assert {:error, :rate_limited} = Blocks.block(ann.id, user("day-over").id)

      # (one still blocked — from another day: a REAL unblock, refused)
      kept = user("day-kept")

      Repo.query!("INSERT INTO blocks (blocker_id, blocked_id, inserted_at) VALUES (?, ?, ?)", [
        ann.id,
        kept.id,
        System.system_time(:second) - 86_400
      ])

      assert {:error, :rate_limited} = Blocks.unblock(ann.id, kept.id)

      # …but a no-op answers as ever, at the limit too: a Block of someone
      # already blocked "ok", an Unblock of someone not blocked "none" — the
      # app's retry of an action whose answer was lost asks exactly that
      # (cross-feature review round 8, 2026-11-25: "too many today" for a
      # block that went through)
      assert :ok = Blocks.block(ann.id, kept.id)
      assert {:error, :none} = Blocks.unblock(ann.id, user("day-never").id)

      # a refusal after the allowance is taken gives it back: unblocking
      # someone not blocked, more times than the day allows
      Hoodride.TestHelpers.scrub_live_state()
      stranger = user("day-stranger")
      for _ <- 1..(n + 5), do: {:error, :none} = Blocks.unblock(ann.id, stranger.id)
      assert :ok = Blocks.block(ann.id, user("day-after").id)
    end
  end

  describe "memory" do
    # (the app's own presence: connected, or in the grace a leaver gets —
    # the one their car, ✋ and chats get — or in a ride or request)
    test "only people around: a leaver's rows stay through the grace, then go; read again when needed" do
      [ann, bob] = [user("me-ann"), user("me-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      assert Blocks.blocked?(ann.id, bob.id)
      assert Blocks.loaded?(ann.id)

      # Ann just left: in the grace — kept
      Hoodride.Geo.user_disconnected(ann.id)
      now = System.monotonic_time(:second)
      Blocks.sweep(now)
      assert Blocks.loaded?(ann.id), "kept through the grace"

      # past it: gone from memory
      Blocks.sweep(now + div(Hoodride.Limits.presence_grace_ms(), 1000) + 1)
      refute Blocks.loaded?(ann.id)
      assert Blocks.blocked?(ann.id, bob.id), "read from the database again"
    end

    test "in a ride, or with a request open: kept past the grace (Hoodride.Presence)" do
      [ann, bob, cat, dan] = [user("mk-ann"), user("mk-bob"), user("mk-cat"), user("mk-dan")]
      :ok = Blocks.block(ann.id, cat.id)
      :ok = Blocks.block(dan.id, cat.id)
      :ok = Blocks.preload(ann.id)
      :ok = Blocks.preload(dan.id)
      {:ok, _} = Hoodride.Rides.start_ride(ann.id, bob.id)
      Hoodride.Geo.driver_update(%{id: bob.id, name: "b", photo: nil}, "cell8", nil)
      later = System.monotonic_time(:second) + 10 * div(Hoodride.Limits.presence_grace_ms(), 1000)
      Blocks.sweep(later)
      assert Blocks.loaded?(ann.id), "in a ride"
      refute Blocks.loaded?(dan.id), "nothing keeps Dan"
    end

    test "someone never seen online (only asked over HTTP): not kept" do
      [ann, bob] = [user("me2-ann"), user("me2-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      assert Blocks.blocked?(ann.id, bob.id)
      Blocks.sweep()
      refute Blocks.loaded?(ann.id)
    end

    test "a load and a block at the same moment: the block is never lost" do
      [ann, bob] = [user("race-ann"), user("race-bob")]
      forget_memory()
      me = self()

      # Ann's rows read from the database (no block yet) — paused before
      # they go into memory; Bob's block is given the chance to run in that
      # gap: without the lock it lands there, and the load then writes
      # memory without it
      {:ok, first} = Agent.start_link(fn -> true end)

      Application.put_env(:hoodride, :blocks_hook, fn
        :loaded ->
          if Agent.get_and_update(first, &{&1, false}) do
            send(me, :paused)

            receive do
              :go -> :ok
            after
              2_000 -> :ok
            end
          end

        :inserted ->
          send(me, :inserted)

        _ ->
          :ok
      end)

      loader = Task.async(fn -> Blocks.blocked?(ann.id, bob.id) end)
      assert_receive :paused
      blocker = Task.async(fn -> Blocks.block(bob.id, ann.id) end)
      # the block either waits for Ann's load (the lock) or lands in the gap
      receive do
        :inserted -> :ok
      after
        300 -> :ok
      end

      send(loader.pid, :go)
      Task.await(loader)
      assert :ok = Task.await(blocker)
      assert Blocks.blocked?(ann.id, bob.id), "the block wasn't lost to the load"
    end

    test "the database can't answer: blocked (never a silent 'not blocked')" do
      [ann, bob] = [user("db-ann"), user("db-bob")]
      forget_memory()

      Application.put_env(:hoodride, :blocks_hook, fn
        :read -> raise DBConnection.ConnectionError, "down"
        _ -> :ok
      end)

      assert Blocks.blocked?(ann.id, bob.id)
      refute Blocks.loaded?(ann.id), "nothing half-loaded kept"
      Application.delete_env(:hoodride, :blocks_hook)
      refute Blocks.blocked?(ann.id, bob.id)
    end
  end

  describe "every change racing a load; the database refusing a change" do
    # `who`'s load pauses between reading its rows and writing memory;
    # `change` runs in that gap (or waits for the load — the person's lock)
    defp during_load(who, change) do
      me = self()
      {:ok, first} = Agent.start_link(fn -> true end)

      Application.put_env(:hoodride, :blocks_hook, fn
        :loaded ->
          if Agent.get_and_update(first, &{&1, false}) do
            send(me, {:paused, self()})

            receive do
              :go -> :ok
            after
              3_000 -> :ok
            end
          end

        _ ->
          :ok
      end)

      loader = Task.async(fn -> Blocks.preload(who) end)
      assert_receive {:paused, pid}, 2_000
      changer = Task.async(change)

      receive do
        :never -> :ok
      after
        200 -> :ok
      end

      send(pid, :go)
      Task.await(loader)
      result = Task.await(changer)
      Application.delete_env(:hoodride, :blocks_hook)
      result
    end

    # (found 2026-11-17, from the capacity run's sign-in twin of it: a check
    # saw "loaded", the Sweeper dropped the person, the check read memory —
    # no row — "not blocked": a blocked car shown)
    test "a check between 'loaded' and its read, the person dropped meanwhile: still blocked" do
      [ann, bob] = [user("dr-ann"), user("dr-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      :ok = Blocks.preload(ann.id)
      me = self()
      {:ok, first} = Agent.start_link(fn -> true end)

      Application.put_env(:hoodride, :blocks_hook, fn
        :checked ->
          if Agent.get_and_update(first, &{&1, false}) do
            send(me, {:paused, self()})

            receive do
              :go -> :ok
            after
              3_000 -> :ok
            end
          end

        _ ->
          :ok
      end)

      check = Task.async(fn -> Blocks.check(ann.id, bob.id) end)
      assert_receive {:paused, pid}, 2_000
      Blocks.sweep()
      refute Blocks.loaded?(ann.id)
      send(pid, :go)
      assert Task.await(check) == true, "a blocked person read as not blocked"
      Application.delete_env(:hoodride, :blocks_hook)
    end

    test "a check in the middle of a drop (between its two steps): still blocked" do
      [ann, bob] = [user("dm-ann"), user("dm-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      :ok = Blocks.preload(ann.id)
      me = self()

      Application.put_env(:hoodride, :blocks_hook, fn
        :dropping ->
          send(me, {:dropping, self()})

          receive do
            :go -> :ok
          after
            3_000 -> :ok
          end

        _ ->
          :ok
      end)

      sweep = Task.async(fn -> Blocks.sweep() end)
      assert_receive {:dropping, pid}, 2_000
      check = Task.async(fn -> Blocks.check(ann.id, bob.id) end)

      receive do
        :never -> :ok
      after
        200 -> :ok
      end

      send(pid, :go)
      Task.await(sweep)
      assert Task.await(check) == true, "read as not blocked mid-drop"
      Application.delete_env(:hoodride, :blocks_hook)
    end

    # (fourth review, 2026-11-19: "still loaded?" couldn't tell a person
    # dropped AND loaded again from one never dropped — a check that read
    # while they were gone took its empty read: "not blocked", a blocked
    # car shown)
    test "dropped and loaded again while a check read: still blocked" do
      [ann, bob] = [user("drl-ann"), user("drl-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      :ok = Blocks.preload(ann.id)
      me = self()
      {:ok, once} = Agent.start_link(fn -> MapSet.new() end)

      Application.put_env(:hoodride, :blocks_hook, fn step ->
        first? = Agent.get_and_update(once, &{not MapSet.member?(&1, step), MapSet.put(&1, step)})

        if step in [:checked, :read_done] and first? do
          send(me, {step, self()})

          receive do
            :go -> :ok
          after
            3_000 -> :ok
          end
        end
      end)

      check = Task.async(fn -> Blocks.check(ann.id, bob.id) end)
      assert_receive {:checked, pid}, 2_000
      Blocks.sweep()
      refute Blocks.loaded?(ann.id)
      send(pid, :go)
      assert_receive {:read_done, ^pid}, 2_000
      :ok = Blocks.preload(ann.id)
      send(pid, :go)
      assert Task.await(check) == true, "a blocked person read as not blocked"
      Application.delete_env(:hoodride, :blocks_hook)
    end

    test "an unblock while the blocker's rows load: stays unblocked" do
      [ann, bob] = [user("ru-ann"), user("ru-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      forget_memory()
      assert :ok = during_load(ann.id, fn -> Blocks.unblock(ann.id, bob.id) end)
      refute Blocks.blocked?(ann.id, bob.id)
      refute Blocks.blocked?(bob.id, ann.id)
    end

    test "an unblock while the blocked one's rows load: stays unblocked for them too" do
      [ann, bob] = [user("ru2-ann"), user("ru2-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      forget_memory()
      assert :ok = during_load(bob.id, fn -> Blocks.unblock(ann.id, bob.id) end)
      refute Blocks.blocked?(bob.id, ann.id)
    end

    test "a block while the blocked one's rows load: seen by them" do
      [ann, bob] = [user("rb-ann"), user("rb-bob")]
      forget_memory()
      assert :ok = during_load(bob.id, fn -> Blocks.block(ann.id, bob.id) end)
      assert Blocks.blocked?(bob.id, ann.id)
    end

    test "an account deleted while the other's rows load: nothing of it left" do
      [ann, bob] = [user("rd-ann"), user("rd-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      forget_memory()

      during_load(bob.id, fn ->
        # (as a deletion: who her blocks name, read before they go)
        partners = Blocks.partners(ann.id)
        Repo.query!("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?", [ann.id, ann.id])
        Blocks.forget(ann.id, partners)
      end)

      refute Blocks.loaded?(ann.id)
      assert :ets.match(:block_rows, {{ann.id, :_}}) == []
      # (and bob's row naming her: his load read the database before her
      # deletion and wrote after it — the deletion now waits for his load:
      # 2026-11-19, it used to stay until he was dropped)
      refute :ets.member(:block_rows, {bob.id, ann.id}), "bob's load put back a row naming ann"
    end

    # the real deletion, through AccountDeletion (its partners read in its
    # transaction): the same — nothing naming the deleted account comes back
    test "an account deleted (the real path) while a partner's rows load: no row naming it comes back" do
      [ann, bob] = [user("rdr-ann"), user("rdr-bob")]
      :ok = Blocks.block(bob.id, ann.id)
      forget_memory()

      assert :ok = during_load(bob.id, fn -> Hoodride.AccountDeletion.delete(ann.id) end)

      assert Blocks.loaded?(bob.id)
      refute :ets.member(:block_rows, {bob.id, ann.id}), "bob's load put back a row naming ann"
    end

    defp refuse(op),
      do:
        Repo.query!(
          "CREATE TRIGGER refuse_blocks_#{op} BEFORE #{op} ON blocks BEGIN SELECT RAISE(ABORT, 'refused'); END"
        )

    defp allow(op), do: Repo.query!("DROP TRIGGER refuse_blocks_#{op}")

    test "the database refuses a block: 'failed', nothing changed anywhere, the day's allowance given back" do
      [ann, bob] = [user("wf-ann"), user("wf-bob")]
      # both in memory: a half-done block would show there
      refute Blocks.blocked?(ann.id, bob.id)
      refuse("INSERT")
      limit = Hoodride.Limits.block_actions_per_day()

      for _ <- 1..(limit + 3),
          do: assert(Blocks.block(ann.id, bob.id) == {:error, :failed})

      refute Blocks.blocked?(ann.id, bob.id)
      refute Blocks.blocked?(bob.id, ann.id)
      assert rows() == []
      allow("INSERT")
      assert :ok = Blocks.block(ann.id, bob.id), "the failures cost nothing"
      assert Blocks.blocked?(bob.id, ann.id)
    end

    # its first look (already blocked? not blocked? — before the allowance)
    # can't READ the table either: "failed" as ever, never a crash taking the
    # user's channel down (cross-feature review round 9, 2026-11-25)
    test "the database can't be read at the first look: 'failed', not a crash" do
      [ann, bob, carl] = [user("wr-ann"), user("wr-bob"), user("wr-carl")]
      :ok = Blocks.block(ann.id, bob.id)
      Repo.query!("ALTER TABLE blocks RENAME TO blocks_away")

      try do
        assert Blocks.unblock(ann.id, bob.id) == {:error, :failed}
        assert Blocks.block(ann.id, carl.id) == {:error, :failed}
      after
        Repo.query!("ALTER TABLE blocks_away RENAME TO blocks")
      end
    end

    test "the database refuses an unblock: 'failed', still blocked everywhere, the allowance given back" do
      [ann, bob] = [user("wf2-ann"), user("wf2-bob")]
      :ok = Blocks.block(ann.id, bob.id)
      assert Blocks.blocked?(bob.id, ann.id)
      refuse("DELETE")
      limit = Hoodride.Limits.block_actions_per_day()

      for _ <- 1..(limit + 3),
          do: assert(Blocks.unblock(ann.id, bob.id) == {:error, :failed})

      assert Blocks.blocked?(ann.id, bob.id)
      assert Blocks.blocked?(bob.id, ann.id)
      assert rows() == [[ann.id, bob.id]]
      allow("DELETE")
      assert :ok = Blocks.unblock(ann.id, bob.id)
      refute Blocks.blocked?(bob.id, ann.id)
    end
  end

  # (2026-11-19: the deletion took every partner's lock at once — waiting for
  # one busy partner while holding the others' held up their loads too.
  # One at a time, as the standard advice goes: each partner's own lock,
  # only for its own row)
  test "deleting an account cleans up each partner under that partner's lock alone" do
    [ann | partners] = for k <- ~w(ol-ann ol-b ol-c ol-d), do: user(k)
    for p <- partners, do: :ok = Blocks.block(p.id, ann.id)
    ids = Enum.map(partners, & &1.id)
    me = self()

    Application.put_env(:hoodride, :blocks_hook, fn
      {:forgetting, o} ->
        # from another process, without waiting: every OTHER partner's lock
        free =
          Task.async(fn ->
            for other <- ids -- [o],
                do: :global.trans({{Blocks, other}, self()}, fn -> :free end, [node()], 0)
          end)
          |> Task.await()

        send(me, {:others_free, o, free})

      _ ->
        :ok
    end)

    on_exit(fn -> Application.delete_env(:hoodride, :blocks_hook) end)
    assert :ok = Hoodride.AccountDeletion.delete(ann.id)

    for o <- ids do
      assert_received {:others_free, ^o, free}

      assert Enum.all?(free, &(&1 == :free)),
             "while cleaning up #{o}, another partner's lock was held"
    end
  end

  # (fifteenth review, 2026-11-19: a deletion took the account's blocks out
  # of memory BEFORE its car and ✋ left the map — in between, someone it
  # blocked (or who blocked it) opening that area saw the car)
  # (one driving, one with ✋ up: raising ✋ takes a car off the map, so one
  # account can't show both — the sixteenth review)
  for kind <- [:car, :hand] do
    @tag kind: kind
    test "deleting an account (#{kind}): off the map before its blocks leave memory", %{
      kind: kind
    } do
      [ann, bob] = [user("om-ann-#{kind}"), user("om-bob-#{kind}")]
      :ok = Blocks.block(bob.id, ann.id)
      Hoodride.Geo.user_connected(ann.id)

      case kind do
        :car ->
          Hoodride.Geo.driver_update(%{id: ann.id, name: "A", photo: nil}, "omC", "omC-s", [])

        :hand ->
          Hoodride.Geo.hand_up(ann.id, "omC", "omC-h", [])
      end

      on_map = fn ->
        case kind do
          :car -> Hoodride.Geo.driver_on_map?(ann.id)
          :hand -> Hoodride.Geo.hand_cell(ann.id) != nil
        end
      end

      assert on_map.()
      me = self()

      Application.put_env(:hoodride, :blocks_hook, fn
        {:forgetting, _} -> send(me, {:on_map, on_map.()})
        _ -> :ok
      end)

      assert :ok = Hoodride.AccountDeletion.delete(ann.id)
      assert_received {:on_map, still?}
      refute still?, "on the map while the blocks naming it were forgotten"
    end
  end

  # (eleventh review, 2026-11-19: "does the other exist?" is asked before
  # the row is written — an account deleted in between made the database
  # refuse the row (its foreign key), read as "the database is down": the
  # app said "try again", and trying again said "not there")
  test "blocking someone whose account is deleted that moment: 'not there', no crash" do
    [ann, bob] = [user("bd-ann"), user("bd-bob")]

    Application.put_env(:hoodride, :blocks_hook, fn
      :inserting -> Repo.query!("DELETE FROM users WHERE id = ?", [bob.id])
      _ -> :ok
    end)

    on_exit(fn -> Application.delete_env(:hoodride, :blocks_hook) end)
    assert Blocks.block(ann.id, bob.id) == {:error, :none}
    assert rows() == []
  end

  test "deleting an account deletes its blocks, both ways" do
    [ann, bob, cat] = [user("del-ann"), user("del-bob"), user("del-cat")]
    :ok = Blocks.block(ann.id, bob.id)
    :ok = Blocks.block(cat.id, ann.id)
    assert :ok = Hoodride.AccountDeletion.delete(ann.id)
    assert rows() == []
    refute Blocks.blocked?(bob.id, ann.id)
    refute Blocks.blocked?(cat.id, ann.id)
  end

  # (full-scan audit, 2026-11-19: forgetting a deleted account read every
  # block row of everyone in memory — {anyone, deleted} has no leading key)
  # a deleted account blocked by one person and blocking another, out of
  # memory itself (its own rows can't name them), both of them in memory:
  # the deletion's work in reductions, and whether their rows naming it went
  defp delete_blocked_account(key) do
    [gone, bob, cat] = [user("#{key}-gone"), user("#{key}-bob"), user("#{key}-cat")]
    :ok = Blocks.block(gone.id, bob.id)
    :ok = Blocks.block(cat.id, gone.id)
    for id <- [bob.id, cat.id], do: :ok = Blocks.preload(id)
    # (as the Sweeper drops it: the mark, then its rows)
    :ets.delete(:block_loaded, gone.id)
    :ets.match_delete(:block_rows, {{gone.id, :_}})

    true =
      :ets.member(:block_rows, {bob.id, gone.id}) and :ets.member(:block_rows, {cat.id, gone.id})

    {:reductions, before} = Process.info(self(), :reductions)
    :ok = Hoodride.AccountDeletion.delete(gone.id)
    {:reductions, later} = Process.info(self(), :reductions)

    left =
      :ets.member(:block_rows, {bob.id, gone.id}) or :ets.member(:block_rows, {cat.id, gone.id})

    {later - before, left}
  end

  test "deleting an account: the others' rows naming it go, and only those are read" do
    # (the 50,000 gone after: a later module that doesn't scrub never sees them)
    on_exit(fn -> Hoodride.TestHelpers.scrub_live_state() end)
    {alone, left} = delete_blocked_account("dsc1")
    refute left, "a row naming the deleted account kept"
    # 50,000 rows of others in memory
    :ets.insert(:block_rows, for(i <- 1..50_000, do: {{2_000_000_000 + i, 3_000_000_000 + i}}))
    {crowded, left} = delete_blocked_account("dsc2")
    refute left, "a row naming the deleted account kept"
    assert :ets.info(:block_rows, :size) == 50_000

    assert crowded - alone < 10_000,
           "#{crowded - alone} more reductions with 50,000 others' block rows: every row read"
  end
end
