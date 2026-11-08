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

    assert SessionTokens.revoke_all(u.id, fn _ -> raise Exqlite.Error, message: "busy" end) ==
             {:error, :failed}

    assert {:ok, _} = SessionTokens.lookup(raw)
    assert rows(u.id) == [[SessionTokens.hash(raw)]]
  end

  # THE RACE the lock is for: a replacement whose database step is done but
  # whose memory step isn't yet, and a sign-out landing in between. Without
  # the account's lock the sign-out cleared memory first, then the
  # replacement put its new token there: signed out, yet signed in.
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
