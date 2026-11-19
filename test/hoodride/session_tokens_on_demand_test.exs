defmodule Hoodride.SessionTokensOnDemandTest do
  @moduledoc """
  Sign-ins read ON DEMAND (owner, 2026-11-17 — Hoodride.SessionTokens):
  nothing loaded at start-up; a person's sign-ins read from the database,
  ALL of them in ONE query, the first time they're needed; kept while
  they're around (Hoodride.Presence), dropped by the Sweeper after, read
  again on return. Once a person is loaded, memory has all their sign-ins:
  a token missing there is signed out, with no read. The database unable
  to answer: `:unavailable` ("try again"), never "signed out" — and never
  a sign-in brought back by a change racing a load.

  Every way in after a restart; every change racing a load; a failure at
  each read; who the Sweeper keeps.
  """
  use Hoodride.DataCase, async: false

  alias Hoodride.{Accounts, Geo, Repo, Requests, Rides, SessionTokens}
  alias Hoodride.TestHelpers

  @day 86_400_000
  @max Hoodride.Limits.sign_ins_per_account()
  @grace div(Hoodride.Limits.presence_grace_ms(), 1000)

  setup do
    TestHelpers.scrub_live_state()
    on_exit(fn -> Application.delete_env(:hoodride, :session_tokens_hook) end)
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp restart, do: :ok = SessionTokens.reset_memory()
  defp mine(user_id), do: :ets.match(:session_tokens, {:"$1", user_id, :_, :_})

  defp rows(user_id),
    do: Repo.query!("SELECT token_hash FROM user_tokens WHERE user_id = ?", [user_id]).rows

  defp age(raw, ms, auth_ms \\ nil),
    do: TestHelpers.age_sign_in(%{"user_token" => raw}, ms, auth_ms)

  defp week_old(u) do
    {:ok, raw} = SessionTokens.create(u.id)
    age(raw, 8 * @day, 100 * @day)
    raw
  end

  # the queries `fun` makes to the sign-ins table (Ecto's telemetry)
  defp token_reads(fun) do
    me = self()
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ -> if meta.query =~ "user_tokens", do: send(me, {:q, meta.query}) end,
      nil
    )

    try do
      result = fun.()
      {result, drain([])}
    after
      :telemetry.detach(id)
    end
  end

  defp drain(acc) do
    receive do
      {:q, q} -> drain([q | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  # the database refuses at `step` (:owner — whose token; :read — the
  # person's rows) until `ok/0`
  defp fail_at(step) do
    Application.put_env(:hoodride, :session_tokens_hook, fn
      ^step -> raise DBConnection.ConnectionError, "down"
      _ -> :ok
    end)
  end

  defp ok, do: Application.delete_env(:hoodride, :session_tokens_hook)

  # the first load pauses at :loaded (its rows read, memory not written
  # yet) until sent :go; → the paused process
  defp pause_first_load do
    me = self()
    {:ok, first} = Agent.start_link(fn -> true end)

    Application.put_env(:hoodride, :session_tokens_hook, fn
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
  end

  # `change` run while a load of `u` is paused between its read and its
  # memory write; the load then finishes
  defp during_load(u, raw, change) do
    pause_first_load()
    loader = Task.async(fn -> SessionTokens.lookup_as(raw, u.id) end)
    assert_receive {:paused, pid}, 2_000
    changer = Task.async(change)
    # the change either waits for the load (the account's lock) or would
    # land in the gap
    receive do
      :never -> :ok
    after
      200 -> :ok
    end

    send(pid, :go)
    Task.await(loader)
    result = Task.await(changer)
    ok()
    result
  end

  describe "read when needed" do
    test "a restart loads nothing; the first lookup reads the person once, then memory only" do
      u = user("od-once")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()
      assert :ets.info(:session_tokens, :size) == 0
      refute SessionTokens.loaded?(u.id)

      {first, reads} = token_reads(fn -> SessionTokens.lookup_as(raw, u.id) end)
      assert {:ok, %{user_id: uid}} = first
      assert uid == u.id
      assert length(reads) == 1, "ONE query: #{inspect(reads)}"

      {again, reads} = token_reads(fn -> SessionTokens.lookup_as(raw, u.id) end)
      assert {:ok, _} = again
      assert reads == [], "from memory"
    end

    test "that one read brings ALL of the account: tokens, renewals, unused replacements" do
      u = user("od-all")
      old = week_old(u)
      {:ok, fresh} = SessionTokens.rotate(old)
      {:ok, other} = SessionTokens.create(u.id)
      restart()

      {_, reads} = token_reads(fn -> SessionTokens.lookup_as(other, u.id) end)
      assert length(reads) == 1
      have = mine(u.id) |> List.flatten() |> MapSet.new()

      assert have ==
               MapSet.new(Enum.map([old, fresh, other], &SessionTokens.hash/1))

      assert [{_, succ, _}] = :ets.lookup(:session_token_links, SessionTokens.hash(old))
      assert succ == SessionTokens.hash(fresh)
      assert [_] = :ets.lookup(:session_token_fresh, SessionTokens.hash(fresh))
    end

    test "only that person: nobody else is read" do
      [a, b] = [user("od-only-a"), user("od-only-b")]
      {:ok, ra} = SessionTokens.create(a.id)
      {:ok, _} = SessionTokens.create(b.id)
      restart()
      assert {:ok, _} = SessionTokens.lookup_as(ra, a.id)
      refute SessionTokens.loaded?(b.id)
      assert mine(b.id) == []
    end

    test "loaded: a token not in memory is signed out — refused with NO read" do
      u = user("od-gone")
      {:ok, raw} = SessionTokens.create(u.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
      stolen = :crypto.strong_rand_bytes(32)
      {res, reads} = token_reads(fn -> SessionTokens.lookup_as(stolen, u.id) end)
      assert res == :error
      assert reads == []
    end

    test "signed out on another device: refused at once, from memory" do
      u = user("od-out")
      {:ok, raw} = SessionTokens.create(u.id)
      {:ok, _} = SessionTokens.revoke_all(u.id)
      {res, reads} = token_reads(fn -> SessionTokens.lookup_as(raw, u.id) end)
      assert res == :error
      assert reads == []
    end

    test "someone else's token named as yours: refused — before and after a restart" do
      [ann, bob] = [user("od-mix-a"), user("od-mix-b")]
      {:ok, anns} = SessionTokens.create(ann.id)
      {:ok, _} = SessionTokens.create(bob.id)
      assert SessionTokens.lookup_as(anns, bob.id) == :error
      restart()
      assert SessionTokens.lookup_as(anns, bob.id) == :error
      refute SessionTokens.loaded?(ann.id), "never Ann's read on Bob's behalf"
    end

    test "nothing to look up: refused with no read (no token, no account, not a number)" do
      u = user("od-junk")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()

      {results, reads} =
        token_reads(fn ->
          [
            SessionTokens.lookup_as(nil, u.id),
            SessionTokens.lookup_as(raw, nil),
            SessionTokens.lookup_as(raw, "#{u.id}"),
            SessionTokens.lookup_as(123, u.id),
            SessionTokens.lookup_hash_as(nil, u.id)
          ]
        end)

      assert Enum.all?(results, &(&1 == :error))
      assert reads == []
    end

    test "whose not known (by the hash alone): read by the hash, then theirs" do
      u = user("od-hash")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()
      assert {:ok, %{user_id: uid}} = SessionTokens.lookup_hash(SessionTokens.hash(raw))
      assert uid == u.id
      assert SessionTokens.loaded?(u.id)
    end

    test "an unknown token by the hash alone: one read, not signed in, nothing kept" do
      user("od-unknown")
      restart()

      {res, reads} =
        token_reads(fn -> SessionTokens.lookup_hash(:crypto.strong_rand_bytes(32)) end)

      assert res == :error
      assert length(reads) == 1
      assert :ets.info(:session_tokens, :size) == 0
      assert :ets.info(:session_token_loaded, :size) == 0
    end

    test "expired in the database: read, and refused — the valid one beside it still works" do
      u = user("od-exp")
      {:ok, live} = SessionTokens.create(u.id)
      {:ok, dead} = SessionTokens.create(u.id)
      age(dead, 31 * @day)
      restart()
      assert SessionTokens.lookup_as(dead, u.id) == :error
      assert {:ok, _} = SessionTokens.lookup_as(live, u.id)
    end

    test "past the year from the real sign-in: refused after a restart too" do
      u = user("od-year")
      {:ok, raw} = SessionTokens.create(u.id)
      age(raw, @day, 366 * @day)
      restart()
      assert SessionTokens.lookup_as(raw, u.id) == :error
    end
  end

  describe "every way in, after a restart" do
    test "signing in again: the cap still counts the ones not in memory" do
      u = user("od-cap")
      tokens = for _ <- 1..@max, do: elem(SessionTokens.create(u.id), 1)
      # a minute apart, the first the oldest — made in one millisecond,
      # "the oldest" is a tie the cap breaks either way (proven: 7 of 20)
      for {t, i} <- Enum.with_index(tokens), do: age(t, (@max - i) * 60_000)
      restart()
      {:ok, newest} = SessionTokens.create(u.id)
      assert length(rows(u.id)) == @max, "never more than the cap"
      assert {:ok, _} = SessionTokens.lookup_as(newest, u.id)
      assert SessionTokens.lookup_as(hd(tokens), u.id) == :error, "the oldest went"
    end

    test "signing in again on the same browser: its previous one replaced, not piled up" do
      u = user("od-prev")
      {:ok, prev} = SessionTokens.create(u.id)
      restart()
      {:ok, next} = SessionTokens.create(u.id, prev)
      assert rows(u.id) == [[SessionTokens.hash(next)]]
      assert SessionTokens.lookup_as(prev, u.id) == :error
    end

    test "a renewal: works on someone not in memory; the real sign-in time carries over" do
      u = user("od-rot")
      old = week_old(u)
      {:ok, info} = SessionTokens.lookup_as(old, u.id)
      restart()
      assert {:ok, new} = SessionTokens.rotate(old)
      {:ok, n} = SessionTokens.lookup_as(new, u.id)
      assert n.authenticated_at == info.authenticated_at
    end

    test "replaced once, never again — the rule holds across a restart" do
      u = user("od-once-rot")
      old = week_old(u)
      {:ok, new} = SessionTokens.rotate(old)
      SessionTokens.used(SessionTokens.hash(new))
      restart()
      assert SessionTokens.rotate(old) == :error
      assert length(rows(u.id)) == 2
    end

    test "a renewal's reply arriving after a restart: marked used (memory and database)" do
      u = user("od-used")
      old = week_old(u)
      {:ok, new} = SessionTokens.rotate(old)
      restart()
      h = SessionTokens.hash(new)
      assert {:ok, _} = SessionTokens.lookup_as(new, u.id)
      SessionTokens.used(h)
      refute :ets.member(:session_token_fresh, h)

      assert Repo.query!("SELECT unused FROM user_tokens WHERE token_hash = ?", [h]).rows ==
               [[0]]
    end

    test "a ride's 'still signed in?': read first — never a false 'signed out'" do
      [rider, nobody] = [user("od-any"), user("od-any-none")]
      {:ok, _} = SessionTokens.create(rider.id)
      restart()
      assert SessionTokens.any?(rider.id)
      refute SessionTokens.any?(nobody.id)
    end

    test "signing out: every sign-in gone; then known to have none — no read after" do
      u = user("od-revoke")
      {:ok, a} = SessionTokens.create(u.id)
      {:ok, _} = SessionTokens.create(u.id)
      restart()
      {:ok, _} = SessionTokens.revoke_all(u.id)
      assert rows(u.id) == []
      {res, reads} = token_reads(fn -> SessionTokens.lookup_as(a, u.id) end)
      assert res == :error
      assert reads == []
    end

    test "an account deleted: nothing of it left in memory, not marked loaded" do
      u = user("od-forget")
      {:ok, raw} = SessionTokens.create(u.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
      SessionTokens.forget(u.id)
      refute SessionTokens.loaded?(u.id)
      assert mine(u.id) == []
    end
  end

  describe "the database can't answer: 'try again', never 'signed out'" do
    test "reading the person: unavailable, nothing half-loaded; fine once it answers" do
      u = user("od-down")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()
      fail_at(:read)
      assert SessionTokens.lookup_as(raw, u.id) == :unavailable
      refute SessionTokens.loaded?(u.id)
      assert mine(u.id) == []
      ok()
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
    end

    test "whose token (by the hash alone): unavailable" do
      u = user("od-down-owner")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()
      fail_at(:owner)
      assert SessionTokens.lookup_hash(SessionTokens.hash(raw)) == :unavailable
    end

    test "the person's rows, after whose was found: unavailable" do
      u = user("od-down-rows")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()
      fail_at(:read)
      assert SessionTokens.lookup_hash(SessionTokens.hash(raw)) == :unavailable
    end

    test "a ride's 'still signed in?': no — no ride starts on a guess" do
      u = user("od-down-any")
      {:ok, _} = SessionTokens.create(u.id)
      restart()
      fail_at(:read)
      refute SessionTokens.any?(u.id)
    end

    test "signing in: refused as unavailable, nothing written" do
      u = user("od-down-create")
      {:ok, _} = SessionTokens.create(u.id)
      restart()
      before = rows(u.id)
      fail_at(:read)
      assert SessionTokens.create(u.id) == {:error, :unavailable}
      assert rows(u.id) == before
    end

    test "a renewal: not now — the old token stays valid" do
      u = user("od-down-rot")
      old = week_old(u)
      restart()
      fail_at(:read)
      assert SessionTokens.rotate(old) == :error
      ok()
      assert {:ok, _} = SessionTokens.lookup_as(old, u.id)
    end

    test "someone already in memory: answered from memory, the database not needed" do
      u = user("od-down-loaded")
      {:ok, raw} = SessionTokens.create(u.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
      fail_at(:read)
      fail_at(:owner)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
      assert SessionTokens.any?(u.id)
    end
  end

  describe "a change racing a load: never a sign-in brought back, never one lost" do
    test "signing out in the gap: stays signed out" do
      u = user("od-race-out")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()
      {:ok, _} = during_load(u, raw, fn -> SessionTokens.revoke_all(u.id) end)
      assert SessionTokens.lookup_as(raw, u.id) == :error
      assert mine(u.id) == []
    end

    test "signing in in the gap: the new sign-in kept" do
      u = user("od-race-in")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()
      {:ok, new} = during_load(u, raw, fn -> SessionTokens.create(u.id) end)
      assert {:ok, _} = SessionTokens.lookup_as(new, u.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
    end

    test "a renewal in the gap: the replacement kept, linked, and unused" do
      u = user("od-race-rot")
      old = week_old(u)
      restart()
      {:ok, new} = during_load(u, old, fn -> SessionTokens.rotate(old) end)
      h = SessionTokens.hash(new)
      assert {:ok, _} = SessionTokens.lookup_as(new, u.id)
      assert [{_, ^h, _}] = :ets.lookup(:session_token_links, SessionTokens.hash(old))
      assert :ets.member(:session_token_fresh, h)
      assert SessionTokens.rotate(old) == :error, "replaced once"
    end

    test "an account deleted in the gap: nothing of it left in memory" do
      u = user("od-race-del")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()
      during_load(u, raw, fn -> SessionTokens.forget(u.id) end)
      refute SessionTokens.loaded?(u.id)
      assert mine(u.id) == []
    end

    test "two loads of one person at once: read once" do
      u = user("od-race-two")
      {:ok, raw} = SessionTokens.create(u.id)
      restart()

      {results, reads} =
        token_reads(fn ->
          1..8
          |> Enum.map(fn _ -> Task.async(fn -> SessionTokens.lookup_as(raw, u.id) end) end)
          |> Enum.map(&Task.await/1)
        end)

      assert Enum.all?(results, &match?({:ok, _}, &1))
      assert length(reads) == 1, "one read for eight at once: #{length(reads)}"
    end
  end

  describe "the Sweeper dropping someone while a check reads them" do
    # (capacity run 2026-11-17: 1 join in ~3,000 refused "signed_out" — a
    # check saw "loaded", the Sweeper dropped the person, the check then
    # found no token: a valid sign-in read as signed out)
    test "a check between 'loaded' and its read, the person dropped meanwhile: still signed in" do
      u = user("od-drop-race")
      {:ok, raw} = SessionTokens.create(u.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
      me = self()
      {:ok, first} = Agent.start_link(fn -> true end)

      Application.put_env(:hoodride, :session_tokens_hook, fn
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

      check = Task.async(fn -> SessionTokens.lookup_as(raw, u.id) end)
      assert_receive {:paused, pid}, 2_000
      # not around: the Sweeper drops them while the check is mid-way
      SessionTokens.sweep()
      refute SessionTokens.loaded?(u.id)
      send(pid, :go)
      assert {:ok, _} = Task.await(check), "a valid sign-in read as signed out"
    end

    test "a check in the middle of a drop (between its two steps): still signed in" do
      u = user("od-drop-mid")
      {:ok, raw} = SessionTokens.create(u.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
      me = self()

      Application.put_env(:hoodride, :session_tokens_hook, fn
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

      sweep = Task.async(fn -> SessionTokens.sweep() end)
      assert_receive {:dropping, pid}, 2_000
      check = Task.async(fn -> SessionTokens.lookup_as(raw, u.id) end)
      # (the check runs now — or waits for the drop to finish)
      receive do
        :never -> :ok
      after
        200 -> :ok
      end

      send(pid, :go)
      Task.await(sweep)
      assert {:ok, _} = Task.await(check), "read as signed out mid-drop"
    end
  end

  describe "who's kept (the Sweeper)" do
    # `secs` on the presence clock (the steady one); the tokens' wall clock
    # moved on by as much
    defp sweep_at(secs),
      do: SessionTokens.sweep(System.system_time(:millisecond) + (secs - now_s()) * 1000, secs)

    defp now_s, do: System.monotonic_time(:second)

    defp loaded!(key) do
      u = user(key)
      {:ok, raw} = SessionTokens.create(u.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
      {u, raw}
    end

    test "connected: kept" do
      {u, _} = loaded!("sw-conn")
      {:ok, _} = Registry.register(Hoodride.UserChannels, u.id, nil)
      sweep_at(now_s() + 10 * @grace)
      assert SessionTokens.loaded?(u.id)
    end

    test "just left: kept through the grace, then dropped — every table" do
      {u, raw} = loaded!("sw-grace")
      {:ok, fresh} = SessionTokens.rotate(raw |> tap(&age(&1, 8 * @day, 100 * @day)))
      Geo.user_disconnected(u.id)
      since = Geo.grace_since(u.id)

      sweep_at(since + @grace)
      assert SessionTokens.loaded?(u.id), "the last second of the grace"

      sweep_at(since + @grace + 1)
      refute SessionTokens.loaded?(u.id)
      assert mine(u.id) == []
      assert :ets.match(:session_token_links, {:_, :_, u.id}) == []
      assert :ets.match(:session_token_fresh, {:_, u.id}) == []
      # back: read again — still signed in, the renewal state intact
      assert {:ok, _} = SessionTokens.lookup_as(fresh, u.id)
      assert :ets.member(:session_token_fresh, SessionTokens.hash(fresh))
    end

    # (the second review, 2026-11-18) how everyone comes back after a
    # restart: read from the database — and when they leave, dropped from
    # every table (found by their own range of the index, not a scan)
    test "read back from the database after a restart, then gone: dropped from every table" do
      {u, raw} = loaded!("sw-db")
      {:ok, fresh} = SessionTokens.rotate(raw |> tap(&age(&1, 8 * @day, 100 * @day)))
      SessionTokens.reset_memory()
      assert {:ok, _} = SessionTokens.lookup_as(fresh, u.id)
      assert SessionTokens.loaded?(u.id) and mine(u.id) != []

      sweep_at(now_s() + 10 * @grace)

      refute SessionTokens.loaded?(u.id)
      assert mine(u.id) == []
      assert :ets.match(:session_token_links, {:_, :_, u.id}) == []
      assert :ets.match(:session_token_fresh, {:_, u.id}) == []
      assert :ets.match(:session_token_by_user, {{u.id, :_}}) == []
    end

    test "in a ride: kept, rider and driver" do
      {r, _} = loaded!("sw-ride-r")
      {d, _} = loaded!("sw-ride-d")
      {:ok, _} = Rides.start_ride(r.id, d.id)
      sweep_at(now_s() + 10 * @grace)
      assert SessionTokens.loaded?(r.id)
      assert SessionTokens.loaded?(d.id)
    end

    test "a ride request open: kept, the rider asking and the driver asked" do
      {r, _} = loaded!("sw-req-r")
      {d, _} = loaded!("sw-req-d")
      Geo.driver_update(%{id: d.id, name: d.name, photo: nil}, "cell8", nil)
      :ok = Requests.create(%{id: r.id, name: r.name, photo: nil}, d.id)
      sweep_at(now_s() + 10 * @grace)
      assert SessionTokens.loaded?(r.id)
      assert SessionTokens.loaded?(d.id)
    end

    test "never around (only asked over HTTP): dropped at the next sweep; still signed in after" do
      {u, raw} = loaded!("sw-http")
      SessionTokens.sweep()
      refute SessionTokens.loaded?(u.id)
      assert {:ok, _} = SessionTokens.lookup_as(raw, u.id)
    end

    test "a dropped person's sign-out still works (read, then all deleted)" do
      {u, raw} = loaded!("sw-out")
      SessionTokens.sweep()
      {:ok, _} = SessionTokens.revoke_all(u.id)
      assert SessionTokens.lookup_as(raw, u.id) == :error
      assert rows(u.id) == []
    end

    test "expired tokens of someone kept: still dropped from memory" do
      {u, _} = loaded!("sw-exp")
      {:ok, dead} = SessionTokens.create(u.id)
      age(dead, 31 * @day)
      Geo.user_disconnected(u.id)
      SessionTokens.sweep()
      assert SessionTokens.loaded?(u.id)
      refute SessionTokens.hash(dead) in List.flatten(mine(u.id))
    end
  end
end
