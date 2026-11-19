defmodule Hoodride.SessionTokensByUserTest do
  @moduledoc """
  One person's sign-ins are found through the per-person index
  (`:session_token_by_user`), never by reading everyone's (2026-11-19):
  "any sign-in left?" (asked when a ride starts) and the 10-per-account cap
  (every sign-in and renewal) read through the whole sign-ins table, so
  their cost grew with everyone signed in.

  Measured in reductions (the BEAM's own work count, which ETS charges by
  rows visited): the same call with 50,000 other people's sign-ins in
  memory must cost about what it costs with none.
  """
  use Hoodride.DataCase, async: false

  alias Hoodride.{Accounts, SessionTokens}
  alias Hoodride.TestHelpers

  @others 50_000

  setup do
    TestHelpers.scrub_live_state()
    # (the 50,000 others gone too: a later module that doesn't scrub never sees them)
    on_exit(fn -> TestHelpers.scrub_live_state() end)
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  # sign-ins of people who aren't in the database: memory only, as the
  # table holds them for everyone around
  defp crowd do
    now = System.system_time(:millisecond)

    rows =
      for i <- 1..@others do
        {:crypto.hash(:sha256, "other#{i}"), 1_000_000_000 + i, now, now}
      end

    :ets.insert(:session_tokens, rows)
    :ets.insert(:session_token_by_user, for({h, uid, _, _} <- rows, do: {{uid, h}}))
  end

  defp work(fun) do
    {:reductions, before} = Process.info(self(), :reductions)
    result = fun.()
    {:reductions, later} = Process.info(self(), :reductions)
    {result, later - before}
  end

  # the call's cost with nobody else, then with the crowd
  defp extra(fun) do
    {_, alone} = work(fun)
    crowd()
    {result, crowded} = work(fun)
    {result, crowded - alone}
  end

  # (the right answer among the crowd. Its cost isn't measured here: the old
  # scan stopped at the first match, wherever that hash happened to sit — 1
  # run in 40 it was cheap (second review, 2026-11-19). The cost is pinned
  # by the case with no match below, which a scan reads in full every time)
  test "any sign-in left? finds that person's among everyone's, and only theirs" do
    u = user("idx-any")
    other = user("idx-any-other")
    {:ok, _} = SessionTokens.create(u.id)
    crowd()
    assert SessionTokens.any?(u.id)
    refute SessionTokens.any?(other.id)

    {:ok, _} = SessionTokens.revoke_all(u.id)
    refute SessionTokens.any?(u.id)
  end

  # (eighth review, 2026-11-19: the list, then the lookups — a sign-in
  # replaced in between (the silent Google refresh: new one in, old one
  # out) was listed as the old one only, found gone: "signed out" — a
  # driver's Accept refused for a rider who is signed in)
  test "any sign-in left? while that person's sign-in is replaced: yes" do
    u = user("idx-swap")
    {:ok, old} = SessionTokens.create(u.id)
    assert SessionTokens.any?(u.id)
    me = self()
    {:ok, once} = Agent.start_link(fn -> true end)

    Application.put_env(:hoodride, :session_tokens_hook, fn
      :listed ->
        if Agent.get_and_update(once, &{&1, false}) do
          send(me, {:listed, self()})

          receive do
            :go -> :ok
          after
            3_000 -> :ok
          end
        end

      _ ->
        :ok
    end)

    on_exit(fn -> Application.delete_env(:hoodride, :session_tokens_hook) end)
    check = Task.async(fn -> SessionTokens.any?(u.id) end)
    assert_receive {:listed, pid}, 2_000
    # signing in again, with the old one: the new in, the old out
    {:ok, _new} = SessionTokens.create(u.id, old)
    send(pid, :go)
    assert Task.await(check), "a signed-in person read as signed out"
  end

  test "any sign-in left? for someone with none reads only theirs" do
    u = user("idx-none")
    refute SessionTokens.any?(u.id)

    {result, extra} = extra(fn -> SessionTokens.any?(u.id) end)
    refute result
    assert extra < 2_000, "#{extra} more reductions with #{@others} others signed in"
  end

  test "the per-account cap counts only that person's" do
    u = user("idx-cap")
    for _ <- 1..3, do: {:ok, _} = SessionTokens.create(u.id)

    {{:ok, _}, extra} = extra(fn -> SessionTokens.create(u.id) end)
    assert extra < 2_000, "#{extra} more reductions with #{@others} others signed in"
  end

  # every query a sign-in or a renewal sends to the sign-ins table, as
  # SQLite plans it: "SCAN user_tokens" is a read of every row
  defp plans(fun) do
    me = self()
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ ->
        if meta.query =~ "user_tokens" and not (meta.query =~ ~r/^\s*INSERT/i),
          do: send(me, {:q, meta.query, meta.params})
      end,
      nil
    )

    try do
      fun.()
    after
      :telemetry.detach(id)
    end

    collect = fn collect, acc ->
      receive do
        {:q, q, params} -> collect.(collect, [{q, params} | acc])
      after
        0 -> Enum.reverse(acc)
      end
    end

    for {q, params} <- collect.(collect, []) do
      plan = Hoodride.Repo.query!("EXPLAIN QUERY PLAN " <> q, params).rows
      {q, Enum.map_join(plan, " | ", &List.last/1)}
    end
  end

  # (2026-11-19, the full-scan audit: every sign-in — the silent Google
  # refresh on each return to the app — deleted everyone's expired
  # (SQLite names the table by Ecto's alias: "SCAN u0" — any SCAN reads
  # every row, or every entry of an index; SEARCH … USING INDEX reads one
  # person's)
  # sign-ins by two unindexed columns: a read of the whole table, holding
  # the database's one write lock)
  test "a sign-in and a renewal read only that person's sign-ins in the database" do
    u = user("idx-db")
    {:ok, _} = SessionTokens.create(u.id)

    planned =
      plans(fn ->
        {:ok, raw} = SessionTokens.create(u.id)
        TestHelpers.age_sign_in(%{"user_token" => raw}, 2 * 86_400_000)
        {:ok, _} = SessionTokens.rotate(raw)
      end)

    assert planned != []

    for {q, plan} <- planned,
        do: refute(plan =~ ~r/\bSCAN\b/, "reads every sign-in:\n#{q}\n#{plan}")
  end

  test "a sign-in deletes its own person's expired rows; others' wait for the start-up" do
    import Ecto.Query
    [u, other] = [user("idx-prune"), user("idx-prune-other")]
    dead = Hoodride.Limits.sign_in_valid_ms() + 60_000
    {:ok, mine} = SessionTokens.create(u.id)
    {:ok, theirs} = SessionTokens.create(other.id)
    TestHelpers.age_sign_in(%{"user_token" => mine}, dead)
    TestHelpers.age_sign_in(%{"user_token" => theirs}, dead)

    row? = fn raw ->
      Hoodride.Repo.exists?(
        from(t in "user_tokens", where: t.token_hash == ^SessionTokens.hash(raw))
      )
    end

    {:ok, _} = SessionTokens.create(u.id)
    refute row?.(mine), "the person's own expired sign-in kept"
    assert row?.(theirs), "another person's touched by this sign-in"

    :ok = SessionTokens.start_up()
    refute row?.(theirs), "the start-up deletes everyone's expired"
  end

  # (fifth review, 2026-11-19: someone who only ever renews — never signs
  # in again — kept every expired row in the database until a deploy)
  test "a renewal deletes its own person's expired rows too" do
    import Ecto.Query
    u = user("idx-prune-renew")
    dead = Hoodride.Limits.sign_in_valid_ms() + 60_000
    {:ok, old} = SessionTokens.create(u.id)
    {:ok, live} = SessionTokens.create(u.id)
    TestHelpers.age_sign_in(%{"user_token" => old}, dead)
    TestHelpers.age_sign_in(%{"user_token" => live}, 2 * 86_400_000)

    row? = fn raw ->
      Hoodride.Repo.exists?(
        from(t in "user_tokens", where: t.token_hash == ^SessionTokens.hash(raw))
      )
    end

    {:ok, _} = SessionTokens.rotate(live)
    refute row?.(old), "an expired sign-in kept by a renewal"
  end

  test "the cap still drops the oldest past the limit, others untouched" do
    u = user("idx-cap-full")
    crowd()
    max = SessionTokens.max_per_account()
    for _ <- 1..(max + 3), do: {:ok, _} = SessionTokens.create(u.id)

    assert length(:ets.match(:session_tokens, {:_, u.id, :_, :_})) == max
    assert :ets.select_count(:session_token_by_user, [{{{u.id, :_}}, [], [true]}]) == max
    assert :ets.info(:session_tokens, :size) == @others + max
  end
end
