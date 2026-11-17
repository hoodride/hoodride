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
      assert Blocks.count(ann.id) == 2
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

      assert {:error, :rate_limited} =
               Blocks.unblock(ann.id, List.last(Enum.take(others, n - half)).id)

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
      now = System.system_time(:second)
      Blocks.sweep(now)
      assert Blocks.loaded?(ann.id), "kept through the grace"

      # past it: gone from memory
      Blocks.sweep(now + div(Hoodride.Limits.presence_grace_ms(), 1000) + 1)
      refute Blocks.loaded?(ann.id)
      assert Blocks.blocked?(ann.id, bob.id), "read from the database again"
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

  test "deleting an account deletes its blocks, both ways" do
    [ann, bob, cat] = [user("del-ann"), user("del-bob"), user("del-cat")]
    :ok = Blocks.block(ann.id, bob.id)
    :ok = Blocks.block(cat.id, ann.id)
    assert :ok = Hoodride.AccountDeletion.delete(ann.id)
    assert rows() == []
    refute Blocks.blocked?(bob.id, ann.id)
    refute Blocks.blocked?(cat.id, ann.id)
  end
end
