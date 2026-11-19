defmodule Hoodride.WarmStartTest do
  @moduledoc """
  The warm start (owner, 2026-11-18 — MySQL's buffer-pool dump/load, the
  same idea): a polite stop writes who's connected (account numbers only)
  to a file; the next start reads that file ONCE, deletes it, and loads
  those people's sign-ins and blocks in a few big reads before the web
  server takes a connection — so the reconnect after a deploy finds them
  in memory. Anything wrong with the file (missing, unreadable, too old),
  the database, or the time allowed: logged, and the start goes on with
  on-demand loading, exactly as without it. Never a wrong answer: what's
  preloaded is what an on-demand read would have found.
  """
  use Hoodride.DataCase, async: false
  import ExUnit.CaptureLog

  alias Hoodride.{Accounts, Blocks, SessionTokens, WarmStart}
  alias Hoodride.TestHelpers

  setup do
    TestHelpers.scrub_live_state()
    path = Path.join(System.tmp_dir!(), "hr-warm-#{System.unique_integer([:positive])}.bin")
    saved = TestHelpers.save_env([:warm_start])
    Application.put_env(:hoodride, :warm_start, path: path, max_age_ms: 600_000, max_ms: 10_000)

    on_exit(fn ->
      TestHelpers.restore_env(saved)
      Application.delete_env(:hoodride, :session_tokens_hook)
      Application.delete_env(:hoodride, :blocks_hook)
      File.rm(path)
      File.rm(path <> ".tmp")
    end)

    %{path: path}
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp restart do
    :ok = SessionTokens.reset_memory()
    :ok = Blocks.reset_memory()
  end

  defp put_cfg(kv),
    do:
      Application.put_env(
        :hoodride,
        :warm_start,
        Keyword.merge(Application.get_env(:hoodride, :warm_start), kv)
      )

  # an app "connected": a live process under the account in the channel directory
  defp connect(user_id) do
    me = self()

    pid =
      spawn(fn ->
        {:ok, _} = Registry.register(Hoodride.UserChannels, user_id, nil)
        send(me, :registered)

        receive do
          {:stop, from} ->
            Registry.unregister(Hoodride.UserChannels, user_id)
            if from, do: send(from, {:gone, self()})
        end
      end)

    assert_receive :registered
    on_exit(fn -> send(pid, {:stop, nil}) end)
    pid
  end

  # the app disconnects (its entry gone before this returns)
  defp disconnect(pid) do
    send(pid, {:stop, self()})
    assert_receive {:gone, ^pid}
  end

  defp write_list(path, ids, saved_at \\ System.system_time(:millisecond)),
    do: File.write!(path, :erlang.term_to_binary({:hoodride_warm_start, 1, saved_at, ids}))

  defp reads(table, fun) do
    me = self()
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ -> if meta.query =~ table, do: send(me, {:q, table}) end,
      nil
    )

    try do
      r = fun.()
      {r, count(table, 0)}
    after
      :telemetry.detach(id)
    end
  end

  defp count(table, n) do
    receive do
      {:q, ^table} -> count(table, n + 1)
    after
      0 -> n
    end
  end

  describe "the save (a polite stop)" do
    test "writes who's connected — and only them", %{path: path} do
      [a, b, gone] = [user("ws-a"), user("ws-b"), user("ws-gone")]
      connect(a.id)
      connect(b.id)
      # two devices' worth for one account: listed once
      connect(b.id)

      assert {:ok, _} = WarmStart.save()
      {:hoodride_warm_start, 1, _at, ids} = :erlang.binary_to_term(File.read!(path))
      assert a.id in ids and b.id in ids
      refute gone.id in ids
      assert Enum.uniq(ids) == ids
      refute File.exists?(path <> ".tmp")
    end

    test "is part of the polite stop, before the restart notice", %{path: path} do
      a = user("ws-stop")
      connect(a.id)
      Phoenix.PubSub.subscribe(Hoodride.PubSub, HoodrideWeb.RestartNotice.topic())
      assert Hoodride.Application.prep_stop(:state) == :state
      assert_receive {:restarting, _}
      {:hoodride_warm_start, 1, _, ids} = :erlang.binary_to_term(File.read!(path))
      assert a.id in ids
    end

    test "can't be written: logged — the stop (and its restart notice) goes on", %{path: path} do
      File.write!(path, "a file where the folder should be")
      put_cfg(path: Path.join(path, "warm_start.bin"))
      connect(user("ws-cant").id)
      Phoenix.PubSub.subscribe(Hoodride.PubSub, HoodrideWeb.RestartNotice.topic())

      log = capture_log(fn -> assert Hoodride.Application.prep_stop(:state) == :state end)
      assert log =~ "warm start: couldn't save"
      assert_receive {:restarting, _}
    end

    test "off (no path): writes nothing" do
      put_cfg(path: nil)
      assert WarmStart.save() == :off
      assert WarmStart.load() == :off
    end
  end

  describe "the load (the next start)" do
    test "their sign-ins and blocks in memory before anyone asks — no read after", %{path: path} do
      [a, b, c] = [user("ws-la"), user("ws-lb"), user("ws-lc")]
      {:ok, raw_a} = SessionTokens.create(a.id)
      {:ok, raw_b} = SessionTokens.create(b.id)
      :ok = Blocks.block(a.id, c.id)
      :ok = Blocks.block(c.id, b.id)
      restart()
      write_list(path, [a.id, b.id])

      assert {:ok, 2} = WarmStart.load()

      {res, n} = reads("user_tokens", fn -> SessionTokens.lookup_as(raw_a, a.id) end)
      assert {:ok, %{user_id: _}} = res
      assert n == 0
      {res, n} = reads("user_tokens", fn -> SessionTokens.lookup_as(raw_b, b.id) end)
      assert {:ok, %{user_id: _}} = res
      assert n == 0

      # both directions of each block, from the preloaded side, with no read
      {res, n} =
        reads("blocks", fn ->
          {Blocks.blocked?(a.id, c.id), Blocks.blocked?(b.id, c.id), Blocks.blocked?(a.id, b.id)}
        end)

      assert res == {true, true, false}
      assert n == 0

      # c wasn't on the list: read on demand, as before — and right
      {res, n} =
        reads("blocks", fn -> {Blocks.blocked?(c.id, a.id), Blocks.blocked?(c.id, b.id)} end)

      assert res == {true, true}
      assert n == 1
      refute SessionTokens.loaded?(c.id)
    end

    test "someone on the list signed out meanwhile: known signed out — no read, no sign-in", %{
      path: path
    } do
      a = user("ws-out")
      {:ok, raw} = SessionTokens.create(a.id)
      {:ok, _} = SessionTokens.revoke_all(a.id)
      restart()
      write_list(path, [a.id])
      assert {:ok, 1} = WarmStart.load()

      {res, n} = reads("user_tokens", fn -> SessionTokens.lookup_as(raw, a.id) end)
      assert res == :error
      assert n == 0
    end

    test "read once: the file is deleted first, a second start finds none", %{path: path} do
      a = user("ws-once")
      write_list(path, [a.id])
      assert {:ok, 1} = WarmStart.load()
      refute File.exists?(path)
      restart()
      assert WarmStart.load() == :none
      refute SessionTokens.loaded?(a.id)
    end

    test "no file (a crash, a first start): nothing loaded, on demand as before" do
      assert WarmStart.load() == :none
    end

    test "a file it can't read: logged, deleted, skipped", %{path: path} do
      File.write!(path, "not a list")
      log = capture_log(fn -> assert WarmStart.load() == :skipped end)
      assert log =~ "warm start"
      refute File.exists?(path)

      # a readable term of the wrong shape, and junk ids inside a good one
      File.write!(path, :erlang.term_to_binary({:something, :else}))
      assert capture_log(fn -> assert WarmStart.load() == :skipped end) =~ "warm start"

      a = user("ws-junk")
      write_list(path, [a.id, "x", nil, -0.5, a.id])
      assert {:ok, 1} = WarmStart.load()
      assert SessionTokens.loaded?(a.id) and Blocks.loaded?(a.id)
    end

    test "a list too old (the server was down a long while): skipped", %{path: path} do
      a = user("ws-old")
      write_list(path, [a.id], System.system_time(:millisecond) - 600_001)
      assert capture_log(fn -> assert WarmStart.load() == :skipped end) =~ "too old"
      refute SessionTokens.loaded?(a.id)
      refute File.exists?(path)
    end

    test "more people than one read takes: read in chunks, everyone loaded", %{path: path} do
      ids = for i <- 1..1_201, do: 10_000_000 + i
      write_list(path, ids)
      {res, n} = reads("user_tokens", fn -> WarmStart.load() end)
      assert res == {:ok, 1_201}
      assert n == 3
      assert Enum.all?(ids, &(SessionTokens.loaded?(&1) and Blocks.loaded?(&1)))
    end

    test "out of time: stops — the rest load on demand", %{path: path} do
      put_cfg(max_ms: -1)
      a = user("ws-time")
      write_list(path, [a.id])
      log = capture_log(fn -> assert {:partial, 0} = WarmStart.load() end)
      assert log =~ "warm start"
      refute SessionTokens.loaded?(a.id)
    end

    test "the database down: logged, nothing half-loaded — the start goes on", %{path: path} do
      a = user("ws-down")
      {:ok, raw} = SessionTokens.create(a.id)
      restart()
      write_list(path, [a.id])

      Application.put_env(:hoodride, :session_tokens_hook, fn
        :read -> raise DBConnection.ConnectionError, "down"
        _ -> :ok
      end)

      log = capture_log(fn -> assert WarmStart.start_link() == :ignore end)
      assert log =~ "warm start"
      refute SessionTokens.loaded?(a.id)
      Application.delete_env(:hoodride, :session_tokens_hook)
      assert {:ok, _} = SessionTokens.lookup_as(raw, a.id)
    end

    test "the blocks read fails: sign-ins kept, blocks on demand (never 'not blocked')", %{
      path: path
    } do
      [a, b] = [user("ws-bd-a"), user("ws-bd-b")]
      :ok = Blocks.block(a.id, b.id)
      restart()
      write_list(path, [a.id])

      Application.put_env(:hoodride, :blocks_hook, fn
        :read -> raise DBConnection.ConnectionError, "down"
        _ -> :ok
      end)

      log = capture_log(fn -> assert WarmStart.load() == {:partial, 0} end)
      assert log =~ "the database failed"
      assert SessionTokens.loaded?(a.id)
      refute Blocks.loaded?(a.id)
      Application.delete_env(:hoodride, :blocks_hook)
      assert Blocks.blocked?(a.id, b.id)
    end

    test "the database fails partway: what was loaded stays (whole chunks), the rest on demand",
         %{path: path} do
      ids = for i <- 1..700, do: 20_000_000 + i
      write_list(path, ids)
      reads = :counters.new(1, [])

      Application.put_env(:hoodride, :session_tokens_hook, fn
        :read ->
          :counters.add(reads, 1, 1)
          if :counters.get(reads, 1) == 2, do: raise(DBConnection.ConnectionError, "down")

        _ ->
          :ok
      end)

      log = capture_log(fn -> assert WarmStart.load() == {:partial, 500} end)
      assert log =~ "500 of 700"
      {first, rest} = Enum.split(ids, 500)
      assert Enum.all?(first, &(SessionTokens.loaded?(&1) and Blocks.loaded?(&1)))
      refute Enum.any?(rest, &(SessionTokens.loaded?(&1) or Blocks.loaded?(&1)))
    end

    test "someone already in memory is left as is", %{path: path} do
      a = user("ws-mem")
      {:ok, raw} = SessionTokens.create(a.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, a.id)
      write_list(path, [a.id])
      {res, n} = reads("user_tokens", fn -> WarmStart.load() end)
      assert res == {:ok, 1}
      assert n == 0
      assert {:ok, _} = SessionTokens.lookup_as(raw, a.id)
    end
  end

  describe "the place in the start" do
    test "after the sign-ins' start-up, before the Sweeper and the web server" do
      ids = for {id, _, _, _} <- Supervisor.which_children(Hoodride.Supervisor), do: id
      at = fn id -> Enum.find_index(ids, &(&1 == id)) || flunk("#{inspect(id)} not started") end
      w = at.(WarmStart)
      # (which_children's order is the start order or its reverse: between, either way)
      for later <- [Hoodride.Sweeper, HoodrideWeb.Endpoint] do
        assert (at.(SessionTokens) < w and w < at.(later)) or
                 (at.(SessionTokens) > w and w > at.(later))
      end
    end
  end

  # everything memory holds for sign-ins and blocks, in order
  defp memory do
    for t <- [
          :session_tokens,
          :session_token_links,
          :session_token_fresh,
          :session_token_loaded,
          # (which sign-ins are whose: the drop finds them by it)
          :session_token_by_user,
          :block_rows,
          :block_loaded
        ],
        do: {t, Enum.sort(Enum.map(:ets.tab2list(t), &without_load_number(t, &1)))}
  end

  # (each load's own number — Hoodride.SessionTokens/Blocks read_loaded —
  # differs from load to load by design: who's loaded is what must match)
  defp without_load_number(t, {id, _n}) when t in [:session_token_loaded, :block_loaded], do: {id}
  defp without_load_number(_t, row), do: row

  describe "preloaded = read on demand (never a different answer)" do
    test "every kind of person: memory exactly as on-demand reads leave it", %{path: path} do
      [multi, rotated, out, expired, blocker, blocked, plain, deleted] =
        for k <- ~w(multi rotated out expired blocker blocked plain deleted),
            do: user("ws-eq-#{k}")

      # two devices
      {:ok, _} = SessionTokens.create(multi.id)
      {:ok, _} = SessionTokens.create(multi.id)
      # a sign-in replaced by a newer one (a link, and a replacement not used yet)
      {:ok, raw} = SessionTokens.create(rotated.id)
      assert {:ok, _} = SessionTokens.rotate(raw)
      # signed out everywhere
      {:ok, _} = SessionTokens.create(out.id)
      {:ok, _} = SessionTokens.revoke_all(out.id)
      # a sign-in past its time (still a row until pruned)
      {:ok, _} = SessionTokens.create(expired.id)

      Repo.query!(
        "UPDATE user_tokens SET inserted_at = 0, authenticated_at = 0 WHERE user_id = ?",
        [
          expired.id
        ]
      )

      # blocks both ways, and one with someone NOT on the list
      :ok = Blocks.block(blocker.id, blocked.id)
      :ok = Blocks.block(blocked.id, plain.id)
      :ok = Blocks.block(plain.id, multi.id)
      # an account whose sign-ins are all gone (its rows deleted)
      {:ok, _} = SessionTokens.create(deleted.id)
      Repo.query!("DELETE FROM user_tokens WHERE user_id = ?", [deleted.id])

      ids = [multi.id, rotated.id, out.id, expired.id, blocker.id, blocked.id, deleted.id]

      # on demand: each one read as a request would
      restart()

      for id <- ids do
        _ = SessionTokens.lookup_hash_as(:crypto.strong_rand_bytes(32), id)
        :ok = Blocks.preload(id)
      end

      on_demand = memory()

      # warm start
      restart()
      write_list(path, ids)
      assert {:ok, 7} = WarmStart.load()
      assert memory() == on_demand
    end
  end

  describe "the file, every way it can be wrong" do
    test "empty", %{path: path} do
      File.write!(path, "")
      assert capture_log(fn -> assert WarmStart.load() == :skipped end) =~ "isn't readable"
      refute File.exists?(path)
    end

    test "cut off part way (a full disk)", %{path: path} do
      bin =
        :erlang.term_to_binary(
          {:hoodride_warm_start, 1, System.system_time(:millisecond), [1, 2, 3]}
        )

      File.write!(path, binary_part(bin, 0, byte_size(bin) - 3))
      assert capture_log(fn -> assert WarmStart.load() == :skipped end) =~ "isn't readable"
    end

    test "a later version's list: skipped, not misread", %{path: path} do
      a = user("ws-v2")

      File.write!(
        path,
        :erlang.term_to_binary(
          {:hoodride_warm_start, 2, System.system_time(:millisecond), [a.id]}
        )
      )

      assert capture_log(fn -> assert WarmStart.load() == :skipped end) =~ "version"
      refute SessionTokens.loaded?(a.id)
    end

    test "names nothing this server knows (no new atoms made from a file)", %{path: path} do
      name = "ws_never_an_atom_#{System.unique_integer([:positive])}"
      # SMALL_ATOM_UTF8_EXT
      File.write!(path, <<131, 119, byte_size(name)>> <> name)
      assert capture_log(fn -> assert WarmStart.load() == :skipped end) =~ "isn't readable"
      assert_raise ArgumentError, fn -> String.to_existing_atom(name) end
    end

    test "a folder where the file should be: skipped, the start goes on", %{path: path} do
      File.mkdir_p!(path)
      on_exit(fn -> File.rm_rf(path) end)
      assert capture_log(fn -> assert WarmStart.start_link() == :ignore end) =~ "warm start"
    end

    test "a half-written list left by a stop that died (.tmp): never read; the next save replaces it",
         %{path: path} do
      a = user("ws-tmp")
      File.write!(path <> ".tmp", "half")
      assert WarmStart.load() == :none
      connect(a.id)
      assert {:ok, _} = WarmStart.save()
      refute File.exists?(path <> ".tmp")
      assert {:ok, n} = WarmStart.load()
      assert n >= 1 and SessionTokens.loaded?(a.id)
    end

    test "the folder isn't there yet: made", %{path: path} do
      dir = Path.join(Path.rootname(path), "deeper")
      on_exit(fn -> File.rm_rf(Path.rootname(path)) end)
      put_cfg(path: Path.join(dir, "warm_start.bin"))
      assert {:ok, _} = WarmStart.save()
      assert File.exists?(Path.join(dir, "warm_start.bin"))
    end

    test "a second save replaces the first (the newest list wins)", %{path: path} do
      [a, b] = [user("ws-2a"), user("ws-2b")]
      pa = connect(a.id)
      assert {:ok, _} = WarmStart.save()
      disconnect(pa)
      connect(b.id)
      assert {:ok, _} = WarmStart.save()
      {:hoodride_warm_start, 1, _, ids} = :erlang.binary_to_term(File.read!(path))
      assert b.id in ids
      refute a.id in ids
    end
  end

  describe "the clock" do
    test "exactly at the age limit: loaded; one millisecond past: skipped", %{path: path} do
      a = user("ws-age")
      now = System.system_time(:millisecond)
      write_list(path, [a.id], now - 600_000)
      assert {:ok, 1} = WarmStart.load(now)
      restart()
      write_list(path, [a.id], now - 600_001)
      assert capture_log(fn -> assert WarmStart.load(now) == :skipped end) =~ "too old"
    end

    test "a little in the future (clocks a bit apart): loaded; far (a clock jump): skipped", %{
      path: path
    } do
      a = user("ws-future")
      now = System.system_time(:millisecond)
      write_list(path, [a.id], now + 5_000)
      assert {:ok, 1} = WarmStart.load(now)
      restart()
      write_list(path, [a.id], now + 600_001)
      assert capture_log(fn -> assert WarmStart.load(now) == :skipped end) =~ "too old"
    end
  end

  describe "the list" do
    test "nobody connected: an empty list, nothing loaded", %{path: path} do
      write_list(path, [])
      assert {:ok, 0} = WarmStart.load()
    end

    test "the same person twice: loaded once", %{path: path} do
      a = user("ws-dup")
      write_list(path, [a.id, a.id, a.id])
      assert {:ok, 1} = WarmStart.load()
    end

    test "exactly one read's worth (500): one read; one more: two", %{path: path} do
      ids = for i <- 1..500, do: 30_000_000 + i
      write_list(path, ids)
      assert {{:ok, 500}, 1} = reads("user_tokens", fn -> WarmStart.load() end)
      restart()
      write_list(path, [30_000_501 | ids])
      assert {{:ok, 501}, 2} = reads("user_tokens", fn -> WarmStart.load() end)
    end

    test "the default place: next to the database" do
      put_cfg(path: :next_to_database)
      db = Application.get_env(:hoodride, Hoodride.Repo)[:database]
      assert WarmStart.path() == Path.join(Path.dirname(db), "warm_start.bin")
    end
  end

  describe "end to end: a polite stop, then the next start" do
    test "those connected come back to memory already loaded; the Sweeper keeps whoever returns",
         %{path: path} do
      [back, away] = [user("ws-e2e-back"), user("ws-e2e-away")]
      {:ok, raw_back} = SessionTokens.create(back.id)
      {:ok, _} = SessionTokens.create(away.id)
      :ok = Blocks.block(back.id, away.id)
      p1 = connect(back.id)
      p2 = connect(away.id)

      assert Hoodride.Application.prep_stop(:state) == :state
      assert File.exists?(path)

      # the stop: everyone's gone, memory is empty
      for p <- [p1, p2], do: disconnect(p)
      restart()

      # the start
      assert WarmStart.start_link() == :ignore
      refute File.exists?(path)

      # `back` reconnects: answered from memory, no reads
      connect(back.id)

      {res, n} = reads("user_tokens", fn -> SessionTokens.lookup_as(raw_back, back.id) end)
      assert {:ok, _} = res
      assert n == 0
      assert {true, 0} = reads("blocks", fn -> Blocks.blocked?(back.id, away.id) end)

      # the Sweeper's first pass: `away` never came back (past the grace) — dropped; `back` kept
      # (presence is aged by the steady clock; the tokens by the wall clock)
      grace = div(Hoodride.Limits.presence_grace_ms(), 1000)
      later = System.monotonic_time(:second) + grace + 5
      SessionTokens.sweep(System.system_time(:millisecond) + (grace + 5) * 1000, later)
      Blocks.sweep(later)
      assert SessionTokens.loaded?(back.id) and Blocks.loaded?(back.id)
      refute SessionTokens.loaded?(away.id) or Blocks.loaded?(away.id)
    end
  end

  describe "many requests at once for someone not in memory (single-flight)" do
    test "sign-ins: one read" do
      a = user("ws-sf")
      {:ok, raw} = SessionTokens.create(a.id)
      restart()

      {res, n} =
        reads("user_tokens", fn ->
          1..20
          |> Enum.map(fn _ -> Task.async(fn -> SessionTokens.lookup_as(raw, a.id) end) end)
          |> Task.await_many()
        end)

      assert Enum.all?(res, &match?({:ok, _}, &1))
      assert n == 1
    end

    test "blocks: one read" do
      [a, b] = [user("ws-sfb-a"), user("ws-sfb-b")]
      :ok = Blocks.block(a.id, b.id)
      restart()

      {res, n} =
        reads("blocks", fn ->
          1..20
          |> Enum.map(fn _ -> Task.async(fn -> Blocks.blocked?(a.id, b.id) end) end)
          |> Task.await_many()
        end)

      assert Enum.all?(res)
      assert n == 1
    end
  end
end
