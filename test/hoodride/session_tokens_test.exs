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
  # the cap (Limits.sign_ins_per_account): these tests hold at any value of it
  @max Hoodride.Limits.sign_ins_per_account()

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

    # …in the database too (after a restart it's read from there)
    :ok = SessionTokens.reset_memory()
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

    # (other steps — a lookup reading someone not in memory — pass)
    Application.put_env(:hoodride, :session_tokens_hook, fn
      :replace -> send(test, {:between, SessionTokens.any?(u.id)})
      _ -> :ok
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

    Application.put_env(:hoodride, :session_tokens_hook, fn
      :rotate ->
        send(test, :rotating)

        receive do
          :go -> :ok
        end

      _ ->
        :ok
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

  # a restart: memory empty — each person's sign-ins read when next needed
  defp restart, do: :ok = SessionTokens.reset_memory()

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

  test "a lost reply at the cap: the count stays at the cap, the phone's token kept" do
    u = user("st-cap-lost")
    old = week_old(u)
    for _ <- 1..(@max - 1), do: SessionTokens.create(u.id)
    {:ok, lost} = SessionTokens.rotate(old)
    assert count(u.id) == @max
    age(lost, 61_000, 0)
    assert {:ok, again} = SessionTokens.rotate(old)
    assert count(u.id) == @max
    assert {:ok, _} = SessionTokens.lookup(old)
    assert {:ok, _} = SessionTokens.lookup(again)
  end

  # (parked 2026-11-14, fixed in the same batch) a sign-in and its renewal
  # no request has used yet are ONE device: its phone may hold either — the
  # renewal's reply arrived and the app was closed right after, or the
  # reply was lost. The cap used to drop that renewal first, and the phone
  # holding it was signed out the next time it opened the app.
  test "the cap never splits a sign-in from its unused renewal: the oldest device goes" do
    u = user("st-cap-renewed")
    old = week_old(u)

    # (the phone's own first sign-in is the OLDEST of all — 8 days — but it
    # renewed just now: devices rank by their latest renewal)
    n = @max - 2

    others =
      for i <- 1..n do
        {:ok, raw} = SessionTokens.create(u.id)
        age(raw, (n - i) * @day + 1_000, 0)
        raw
      end

    # the phone renews, gets the reply, and the app is closed
    {:ok, renewed} = SessionTokens.rotate(old)
    assert count(u.id) == @max

    # one sign-in more somewhere
    {:ok, _} = SessionTokens.create(u.id)
    assert count(u.id) <= @max
    assert {:ok, _} = SessionTokens.lookup(renewed), "the phone's renewal kept"
    assert {:ok, _} = SessionTokens.lookup(old), "…and the token before it (a lost reply)"
    assert SessionTokens.lookup(hd(others)) == :error, "the oldest device went instead"
  end

  test "the cap drops expired (unswept) sign-ins first; a device's renewal goes with it" do
    u = user("st-cap-order")
    {:ok, expired} = SessionTokens.create(u.id)
    age(expired, 31 * @day)
    other_old = week_old(u)
    {:ok, orphan} = SessionTokens.rotate(other_old)
    # the renewal pair is the OLDEST device: its renewal 10 days ago
    age(orphan, 10 * @day, 100 * @day)
    for _ <- 1..(@max - 2), do: SessionTokens.create(u.id)
    # expired, other_old, orphan + the rest: one over (the expired one went); one more
    {:ok, _} = SessionTokens.create(u.id)
    assert count(u.id) <= @max
    assert rows(u.id) |> List.flatten() |> Enum.member?(SessionTokens.hash(expired)) == false
    # the whole device, both tokens — never one of the two
    assert SessionTokens.lookup(orphan) == :error
    assert SessionTokens.lookup(other_old) == :error
  end

  test "signing in again from the same browser at the cap: still at the cap, the old one replaced" do
    u = user("st-cap-again")
    raws = for _ <- 1..@max, do: elem(SessionTokens.create(u.id), 1)
    {:ok, again} = SessionTokens.create(u.id, List.last(raws))
    assert count(u.id) == @max
    assert SessionTokens.lookup(List.last(raws)) == :error
    assert {:ok, _} = SessionTokens.lookup(again)
    for r <- Enum.drop(raws, -1), do: assert({:ok, _} = SessionTokens.lookup(r))
  end

  test "at most the cap per account: signing in again and again keeps the newest" do
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
    assert length(:ets.match(:session_tokens, {:_, u.id, :_, :_})) == @max
    for r <- Enum.take(raws, -@max), do: assert({:ok, _} = SessionTokens.lookup(r))
    for r <- Enum.take(raws, 15 - @max), do: assert(SessionTokens.lookup(r) == :error)
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
    # 3 so far; one over the cap with the rest
    for _ <- 1..(@max - 2), do: SessionTokens.create(u.id)

    assert count(u.id) == @max
    assert SessionTokens.lookup(replaced) == :error, "the replaced one went first"
    assert {:ok, _} = SessionTokens.lookup(oldest), "not the oldest in use"
    assert {:ok, _} = SessionTokens.lookup(successor)
    assert {:ok, _} = SessionTokens.lookup(theirs)
  end

  test "a renewal at the cap keeps the token being renewed and its replacement" do
    u = user("st-cap3")
    old = week_old(u)
    for _ <- 1..(@max - 1), do: SessionTokens.create(u.id)
    assert count(u.id) == @max
    assert {:ok, new} = SessionTokens.rotate(old)
    assert count(u.id) == @max
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
    # another account's renewal, still valid: kept (its owner still around
    # — just left, in the grace; one not around is dropped whole: the
    # memory tests below)
    v = user("st-sweep-keep")
    keep_old = week_old(v)
    {:ok, keep_new} = SessionTokens.rotate(keep_old)
    Hoodride.Geo.user_disconnected(v.id)

    :ok = SessionTokens.sweep()
    assert :ets.lookup(:session_token_links, SessionTokens.hash(old)) == []
    assert :ets.lookup(:session_token_fresh, SessionTokens.hash(new)) == []
    assert [_] = :ets.lookup(:session_token_links, SessionTokens.hash(keep_old))
    assert [_] = :ets.lookup(:session_token_fresh, SessionTokens.hash(keep_new))
  end

  test "a restart: nothing loaded — read when first needed; expired rows deleted at start-up" do
    u = user("st-load")
    {:ok, live} = SessionTokens.create(u.id)
    {:ok, dead} = SessionTokens.create(u.id)
    age(dead, 31 * @day)

    :ok = SessionTokens.reset_memory()
    :ok = SessionTokens.start_up()
    refute SessionTokens.loaded?(u.id)
    assert :ets.info(:session_tokens, :size) == 0, "nothing read at start-up"

    assert {:ok, _} = SessionTokens.lookup_as(live, u.id)
    assert SessionTokens.loaded?(u.id)
    assert SessionTokens.lookup_as(dead, u.id) == :error
    assert rows(u.id) == [[SessionTokens.hash(live)]]
  end

  test "the sweep drops expired tokens from memory" do
    u = user("st-sweep")
    {:ok, raw} = SessionTokens.create(u.id)
    age(raw, 31 * @day)
    :ok = SessionTokens.sweep()
    assert :ets.lookup(:session_tokens, SessionTokens.hash(raw)) == []
  end

  # (the third review, 2026-11-18) the "whose" index never outgrows the
  # sign-ins it points at — for someone always around too (never dropped)
  test "the index of whose sign-ins: a sign-in expired or dropped by the cap leaves it too" do
    u = user("st-idx")
    {:ok, _} = Registry.register(Hoodride.UserChannels, u.id, nil)
    whose = fn -> :ets.select(:session_token_by_user, [{{{u.id, :"$1"}}, [], [:"$1"]}]) end
    mine = fn -> :ets.select(:session_tokens, [{{:"$1", u.id, :_, :_}, [], [:"$1"]}]) end

    # the cap: more sign-ins than an account keeps — the oldest go
    for _ <- 1..(SessionTokens.max_per_account() + 2), do: {:ok, _} = SessionTokens.create(u.id)
    assert Enum.sort(whose.()) == Enum.sort(mine.())

    # expiry: every one past its 30 days (still around: not dropped)
    for h <- mine.(), do: :ets.update_element(:session_tokens, h, [{3, 0}, {4, 0}])
    :ok = SessionTokens.sweep()
    assert SessionTokens.loaded?(u.id)
    assert mine.() == []
    assert whose.() == [], "index rows left for sign-ins that are gone"
  end

  test "deleting the account deletes its tokens (the database's cascade)" do
    u = user("st-del")
    {:ok, _} = SessionTokens.create(u.id)
    Repo.delete!(Accounts.get_user(u.id))
    assert rows(u.id) == []
  end
end
