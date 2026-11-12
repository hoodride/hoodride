defmodule Hoodride.SessionTokensTest do
  @moduledoc """
  Sign-in tokens (Hoodride.SessionTokens) — Phoenix's own design: a random
  token per signed-in device, its SHA-256 in `user_tokens`, read from memory;
  30 days, replaced weekly while in use, a year at most from the real
  sign-in; sign-out deletes every token of the account.
  """
  use Hoodride.DataCase, async: false

  alias Hoodride.{Accounts, Repo, SessionTokens}
  alias Hoodride.TestHelpers

  @day 86_400_000

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp rows(user_id),
    do: Repo.query!("SELECT token_hash FROM user_tokens WHERE user_id = ?", [user_id]).rows

  defp age(raw, ms, auth_ms \\ nil),
    do: TestHelpers.age_sign_in(%{"user_token" => raw}, ms, auth_ms)

  setup do
    on_exit(fn -> Application.delete_env(:hoodride, :session_tokens_hook) end)
    :ok
  end

  test "a sign-in: valid at once; only its SHA-256 is stored, never the token" do
    u = user("st-new")
    {:ok, raw} = SessionTokens.create(u.id)
    assert {:ok, %{user_id: id}} = SessionTokens.lookup(raw)
    assert id == u.id
    assert rows(u.id) == [[SessionTokens.hash(raw)]]
    refute SessionTokens.hash(raw) == raw
  end

  test "30 days: 29 days old works, 31 days old doesn't" do
    u = user("st-30")
    {:ok, a} = SessionTokens.create(u.id)
    {:ok, b} = SessionTokens.create(u.id)
    age(a, 29 * @day)
    age(b, 31 * @day)
    assert {:ok, _} = SessionTokens.lookup(a)
    assert SessionTokens.lookup(b) == :error
  end

  test "a year at most from the real sign-in, however recently replaced" do
    u = user("st-cap")
    {:ok, raw} = SessionTokens.create(u.id)
    age(raw, 0, 366 * @day)
    assert SessionTokens.lookup(raw) == :error
  end

  test "replaced: a new token, the real sign-in time carried over; the old one still works" do
    u = user("st-rot")
    {:ok, old} = SessionTokens.create(u.id)
    age(old, 8 * @day, 100 * @day)
    {:ok, info} = SessionTokens.lookup(old)
    assert SessionTokens.due?(info)

    assert {:ok, new} = SessionTokens.rotate(old)
    {:ok, n} = SessionTokens.lookup(new)
    assert n.authenticated_at == info.authenticated_at
    refute SessionTokens.due?(n)

    # …in the database too (a restart reads it from there)
    :ets.delete_all_objects(:session_tokens)
    :ok = SessionTokens.load()
    {:ok, reloaded} = SessionTokens.lookup(new)
    assert reloaded.authenticated_at == info.authenticated_at
    assert {:ok, _} = SessionTokens.lookup(old), "requests already on their way carry it"
  end

  test "a token that is gone (signed out) is never replaced — nothing is made" do
    u = user("st-gone")
    {:ok, raw} = SessionTokens.create(u.id)
    {:ok, _} = SessionTokens.revoke_all(u.id)
    assert SessionTokens.rotate(raw) == :error
    assert rows(u.id) == []
  end

  test "signing in again from the same browser replaces its token (no pile-up); another account's stays" do
    u = user("st-again")
    other = user("st-other")
    {:ok, first} = SessionTokens.create(u.id)
    {:ok, second} = SessionTokens.create(u.id, first)
    assert SessionTokens.lookup(first) == :error
    assert {:ok, _} = SessionTokens.lookup(second)
    assert rows(u.id) == [[SessionTokens.hash(second)]]

    {:ok, theirs} = SessionTokens.create(other.id)
    {:ok, _} = SessionTokens.create(u.id, theirs)
    assert {:ok, _} = SessionTokens.lookup(theirs), "not this account's to delete"
  end

  test "sign out everywhere: every token of the account, memory and database; others untouched" do
    u = user("st-out")
    other = user("st-keep")
    {:ok, a} = SessionTokens.create(u.id)
    {:ok, b} = SessionTokens.create(u.id)
    {:ok, keep} = SessionTokens.create(other.id)

    assert {:ok, _at} = SessionTokens.revoke_all(u.id)
    assert SessionTokens.lookup(a) == :error
    assert SessionTokens.lookup(b) == :error
    assert rows(u.id) == []
    assert {:ok, _} = SessionTokens.lookup(keep)
  end

  test "a sign-out the database can't make changes NOTHING" do
    u = user("st-fail")
    {:ok, raw} = SessionTokens.create(u.id)

    # a real database failure: the sign-ins can't be deleted
    Hoodride.Repo.query!(
      "CREATE TRIGGER refuse_x BEFORE DELETE ON user_tokens BEGIN SELECT RAISE(ABORT, 'busy'); END"
    )

    assert SessionTokens.revoke_all(u.id) == {:error, :failed}

    assert {:ok, _} = SessionTokens.lookup(raw)
    assert rows(u.id) == [[SessionTokens.hash(raw)]]
  end

  # THE RACE the lock is for: a replacement whose database step is done but
  # whose memory step isn't yet, and a sign-out landing in between. Without
  # the account's lock the sign-out cleared memory first, then the
  # replacement put its new token there: signed out, yet signed in.
  # signing in again from the same browser (the silent Google refresh, on
  # every return) replaces its token: never a moment with none — a ride's
  # start asks "any sign-in left?" of its rider (any?/1; A1, third review
  # 2026-11-11: a signed-in rider would have been declined in between)
  test "signing in again: the new sign-in in before the old one out — never none" do
    u = user("st-again")
    {:ok, old} = SessionTokens.create(u.id)
    test = self()

    Application.put_env(:hoodride, :session_tokens_hook, fn :replace ->
      send(test, {:between, SessionTokens.any?(u.id)})
    end)

    assert {:ok, new} = SessionTokens.create(u.id, old)
    assert_received {:between, true}
    # …and then just the new one
    assert SessionTokens.lookup(old) == :error
    assert {:ok, _} = SessionTokens.lookup(new)
  end

  test "any?: a sign-in left, by account — none after signing out" do
    u = user("st-any")
    other = user("st-any-other")
    refute SessionTokens.any?(u.id)
    {:ok, _} = SessionTokens.create(u.id)
    {:ok, _} = SessionTokens.create(other.id)
    assert SessionTokens.any?(u.id)
    {:ok, _} = SessionTokens.revoke_all(u.id)
    refute SessionTokens.any?(u.id)
    assert SessionTokens.any?(other.id)
  end

  test "a sign-out can't slip in between a replacement's two steps" do
    u = user("st-race")
    {:ok, old} = SessionTokens.create(u.id)
    test = self()

    Application.put_env(:hoodride, :session_tokens_hook, fn :rotate ->
      send(test, :rotating)

      receive do
        :go -> :ok
      end
    end)

    rotation = Task.async(fn -> SessionTokens.rotate(old) end)
    assert_receive :rotating, 2_000
    Application.delete_env(:hoodride, :session_tokens_hook)

    sign_out = Task.async(fn -> SessionTokens.revoke_all(u.id) end)
    # the sign-out must wait for the replacement to finish
    refute Task.yield(sign_out, 200), "the sign-out ran in the middle of the replacement"
    send(rotation.pid, :go)
    assert {:ok, new} = Task.await(rotation)
    assert {:ok, _} = Task.await(sign_out)

    assert SessionTokens.lookup(new) == :error, "signed out, yet the new token is valid"
    assert SessionTokens.lookup(old) == :error
    assert rows(u.id) == []
  end

  # ---------- the key fix (owner, 2026-11-12) ----------
  # A replayed week-old cookie made a NEW token on every request (the old
  # one stays valid, and was never marked replaced): ~86k a day per account
  # at the HTTP budget, kept 30 days, reloaded at start-up — memory full.
  # Now a token is replaced once; again only when its replacement went
  # unused a minute (its reply lost); and an account holds at most 10.

  defp week_old(u) do
    {:ok, raw} = SessionTokens.create(u.id)
    age(raw, 8 * @day, 100 * @day)
    raw
  end

  defp count(user_id), do: length(rows(user_id))
  defp use!(raw), do: SessionTokens.used(SessionTokens.hash(raw))

  test "a replayed old cookie: replaced once, never again — 100 replays make nothing" do
    u = user("st-replay")
    old = week_old(u)
    assert {:ok, new} = SessionTokens.rotate(old)
    use!(new)

    for _ <- 1..100, do: assert(SessionTokens.rotate(old) == :error)

    assert count(u.id) == 2
    assert {:ok, _} = SessionTokens.lookup(old), "still valid (requests on their way)"
    assert {:ok, _} = SessionTokens.lookup(new)
  end

  test "requests sent together, all with the old token: one replacement, never taken back" do
    u = user("st-together")
    old = week_old(u)

    results = 1..8 |> Enum.map(fn _ -> Task.async(fn -> SessionTokens.rotate(old) end) end)
    oks = for t <- results, {:ok, raw} <- [Task.await(t)], do: raw

    assert length(oks) == 1
    assert count(u.id) == 2
    # a moment later (inside the minute), unused yet: still nothing new
    assert SessionTokens.rotate(old) == :error
    assert {:ok, _} = SessionTokens.lookup(hd(oks))
  end

  test "a lost reply: the replacement unused a minute — taken back, another made (no pile-up)" do
    u = user("st-lost")
    old = week_old(u)
    {:ok, lost} = SessionTokens.rotate(old)
    # the phone never got `lost`: a minute on, it renews again with the old one
    age(lost, 61_000, 0)

    assert {:ok, again} = SessionTokens.rotate(old)
    assert SessionTokens.lookup(lost) == :error, "the unused one taken back"
    assert {:ok, _} = SessionTokens.lookup(again)
    assert count(u.id) == 2

    # …and replaying it still never grows the pile
    Enum.reduce(1..20, again, fn _, latest ->
      age(latest, 61_000, 0)
      assert {:ok, next} = SessionTokens.rotate(old)
      next
    end)

    assert count(u.id) == 2
  end

  test "a replacement in use is never taken back, however long after" do
    u = user("st-inuse")
    old = week_old(u)
    {:ok, new} = SessionTokens.rotate(old)
    use!(new)
    age(new, 6 * @day, 0)
    assert SessionTokens.rotate(old) == :error
    assert {:ok, _} = SessionTokens.lookup(new)
  end

  test "a request through the sign-in check marks the replacement used" do
    u = user("st-mark")
    old = week_old(u)
    {:ok, new} = SessionTokens.rotate(old)
    assert :ets.member(:session_token_fresh, SessionTokens.hash(new))

    session = %{"user_token" => new, "user_id" => u.id, "name" => "x"}
    assert %{id: _} = HoodrideWeb.Auth.session_user(session)
    refute :ets.member(:session_token_fresh, SessionTokens.hash(new))

    age(new, 61_000, 0)
    assert SessionTokens.rotate(old) == :error, "used: never taken back"
  end

  defp restart do
    for t <- [:session_tokens, :session_token_links, :session_token_fresh],
        do: :ets.delete_all_objects(t)

    :ok = SessionTokens.load()
  end

  test "replaced, and in use, survive a restart: still never renewed again" do
    u = user("st-restart")
    old = week_old(u)
    {:ok, new} = SessionTokens.rotate(old)
    use!(new)
    restart()
    assert {:ok, _} = SessionTokens.lookup(old)
    age(new, 61_000, 0)
    assert SessionTokens.rotate(old) == :error
    assert count(u.id) == 2
  end

  # (review, 2026-11-12: memory-only, a lost reply then a deploy left the
  # phone never renewing — signed out ~3 weeks later)
  test "a lost reply survives a restart: the phone still renews after it" do
    u = user("st-restart-lost")
    old = week_old(u)
    {:ok, lost} = SessionTokens.rotate(old)
    restart()
    age(lost, 61_000, 0)
    assert {:ok, again} = SessionTokens.rotate(old)
    assert SessionTokens.lookup(lost) == :error
    assert {:ok, _} = SessionTokens.lookup(again)
    assert count(u.id) == 2
  end

  test "a socket connect naming the new token marks it used (an app kept open)" do
    u = user("st-socket")
    old = week_old(u)
    {:ok, new} = SessionTokens.rotate(old)
    {:ok, info} = SessionTokens.lookup(new)
    pass = HoodrideWeb.Auth.socket_token(%{id: u.id, name: "x", photo: nil, token: info})
    assert %{id: _} = HoodrideWeb.Auth.token_user(pass)
    refute :ets.member(:session_token_fresh, info.hash)
    age(new, 61_000, 0)
    assert SessionTokens.rotate(old) == :error
    restart()
    assert SessionTokens.rotate(old) == :error, "…and the database says so too"
  end

  test "a lost reply at the cap: the count stays 10, the phone's token kept" do
    u = user("st-cap-lost")
    old = week_old(u)
    for _ <- 1..9, do: SessionTokens.create(u.id)
    {:ok, lost} = SessionTokens.rotate(old)
    assert count(u.id) == 10
    age(lost, 61_000, 0)
    assert {:ok, again} = SessionTokens.rotate(old)
    assert count(u.id) == 10
    assert {:ok, _} = SessionTokens.lookup(old)
    assert {:ok, _} = SessionTokens.lookup(again)
  end

  test "the cap drops expired (unswept) and unused replacements before anything in use" do
    u = user("st-cap-order")
    {:ok, expired} = SessionTokens.create(u.id)
    age(expired, 31 * @day)
    other_old = week_old(u)
    {:ok, orphan} = SessionTokens.rotate(other_old)
    for _ <- 1..8, do: SessionTokens.create(u.id)
    # expired, other_old, orphan + 8: the 11th went (the expired one); one more
    {:ok, _} = SessionTokens.create(u.id)
    assert count(u.id) == 10
    assert rows(u.id) |> List.flatten() |> Enum.member?(SessionTokens.hash(expired)) == false
    assert SessionTokens.lookup(orphan) == :error, "the unused replacement went"
    assert {:ok, _} = SessionTokens.lookup(other_old), "its device's token kept"
  end

  test "signing in again from the same browser at the cap: still 10, the old one replaced" do
    u = user("st-cap-again")
    raws = for _ <- 1..10, do: elem(SessionTokens.create(u.id), 1)
    {:ok, again} = SessionTokens.create(u.id, List.last(raws))
    assert count(u.id) == 10
    assert SessionTokens.lookup(List.last(raws)) == :error
    assert {:ok, _} = SessionTokens.lookup(again)
    for r <- Enum.drop(raws, -1), do: assert({:ok, _} = SessionTokens.lookup(r))
  end

  test "at most 10 sign-ins per account: signing in again and again keeps the newest" do
    u = user("st-cap")
    # each its own time, earlier ones older — sign-ins in one millisecond
    # tie, and among equally old ones any may go (precommit, 2026-11-12:
    # the newest-10 check failed on a tie)
    raws =
      for i <- 1..15 do
        {:ok, raw} = SessionTokens.create(u.id)
        age(raw, (16 - i) * 1_000, 0)
        raw
      end

    assert count(u.id) == SessionTokens.max_per_account()
    assert length(:ets.match(:session_tokens, {:_, u.id, :_, :_})) == 10
    for r <- Enum.take(raws, -10), do: assert({:ok, _} = SessionTokens.lookup(r))
    for r <- Enum.take(raws, 5), do: assert(SessionTokens.lookup(r) == :error)
  end

  test "the cap drops replaced sign-ins first, then the oldest; another account untouched" do
    u = user("st-cap2")
    other = user("st-cap2-other")
    {:ok, theirs} = SessionTokens.create(other.id)
    {:ok, oldest} = SessionTokens.create(u.id)
    age(oldest, 20 * @day)
    replaced = week_old(u)
    {:ok, successor} = SessionTokens.rotate(replaced)
    use!(successor)
    # 3 so far; 8 more makes 11
    for _ <- 1..8, do: SessionTokens.create(u.id)

    assert count(u.id) == 10
    assert SessionTokens.lookup(replaced) == :error, "the replaced one went first"
    assert {:ok, _} = SessionTokens.lookup(oldest), "not the oldest in use"
    assert {:ok, _} = SessionTokens.lookup(successor)
    assert {:ok, _} = SessionTokens.lookup(theirs)
  end

  test "a renewal at the cap keeps the token being renewed and its replacement" do
    u = user("st-cap3")
    old = week_old(u)
    for _ <- 1..9, do: SessionTokens.create(u.id)
    assert count(u.id) == 10
    assert {:ok, new} = SessionTokens.rotate(old)
    assert count(u.id) == 10
    assert {:ok, _} = SessionTokens.lookup(old)
    assert {:ok, _} = SessionTokens.lookup(new)
  end

  test "signing out clears what was kept about replacements too" do
    u = user("st-out-links")
    old = week_old(u)
    {:ok, _} = SessionTokens.rotate(old)
    {:ok, _} = SessionTokens.revoke_all(u.id)
    assert :ets.match(:session_token_links, {:_, :_, u.id}) == []
    assert :ets.match(:session_token_fresh, {:_, u.id}) == []
  end

  test "the sweep drops what was kept about tokens that expired" do
    u = user("st-sweep-links")
    old = week_old(u)
    {:ok, new} = SessionTokens.rotate(old)
    age(old, 31 * @day)
    age(new, 31 * @day)
    # another account's renewal, still valid: kept
    v = user("st-sweep-keep")
    keep_old = week_old(v)
    {:ok, keep_new} = SessionTokens.rotate(keep_old)

    :ok = SessionTokens.sweep()
    assert :ets.lookup(:session_token_links, SessionTokens.hash(old)) == []
    assert :ets.lookup(:session_token_fresh, SessionTokens.hash(new)) == []
    assert [_] = :ets.lookup(:session_token_links, SessionTokens.hash(keep_old))
    assert [_] = :ets.lookup(:session_token_fresh, SessionTokens.hash(keep_new))
  end

  test "a restart: memory refilled from the database; expired rows deleted" do
    u = user("st-load")
    {:ok, live} = SessionTokens.create(u.id)
    {:ok, dead} = SessionTokens.create(u.id)
    age(dead, 31 * @day)

    :ets.delete_all_objects(:session_tokens)
    assert SessionTokens.lookup(live) == :error
    :ok = SessionTokens.load()

    assert {:ok, _} = SessionTokens.lookup(live)
    assert SessionTokens.lookup(dead) == :error
    assert rows(u.id) == [[SessionTokens.hash(live)]]
  end

  test "the sweep drops expired tokens from memory" do
    u = user("st-sweep")
    {:ok, raw} = SessionTokens.create(u.id)
    age(raw, 31 * @day)
    :ok = SessionTokens.sweep()
    assert :ets.lookup(:session_tokens, SessionTokens.hash(raw)) == []
  end

  test "deleting the account deletes its tokens (the database's cascade)" do
    u = user("st-del")
    {:ok, _} = SessionTokens.create(u.id)
    Repo.delete!(Accounts.get_user(u.id))
    assert rows(u.id) == []
  end
end
