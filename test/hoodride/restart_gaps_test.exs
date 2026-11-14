defmodule Hoodride.RestartGapsTest do
  @moduledoc """
  A shared piece restarting at a bad moment (crash review, 2026-11-14). Each
  case here used to crash a caller — or worse:

    * the ride supervisor unavailable at Accept: the driver's connection
      crashed with both seats still claimed — both people "in a ride" with
      no ride until the server restarted (the Sweeper leaves a starting
      ride alone);
    * the rate-limit table gone (its owner — Hammer's process — restarting):
      every send, request, cancel and decline crashed its connection;
    * the database's supervisor restarting: Ecto raises a plain
      RuntimeError then, which no "database unavailable" rescue knew;
    * Erlang older than 28: a cryptic crash of every map writer at start.

  "Unavailable" is made by taking the piece's NAME away for a moment (the
  piece itself keeps running, put back after) — exactly what a caller sees
  while it restarts. Not async: those names are everyone's.
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Rides, Throttle}

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  # `name` unregistered for the length of `fun`
  defp without_name(name, fun) do
    pid = Process.whereis(name)
    Process.unregister(name)

    try do
      fun.()
    after
      Process.register(pid, name)
    end
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  test "the ride supervisor unavailable at Accept: an error, and both seats freed" do
    r = user("rg-r1")
    d = user("rg-d1")

    without_name(Hoodride.Rides.Supervisor, fn ->
      assert {:error, {:start_failed, _}} = Rides.start_ride(r.id, d.id)
    end)

    assert Rides.ride_id_of_user(r.id) == nil
    assert Rides.ride_id_of_user(d.id) == nil
    # and a ride starts normally once it's back
    assert {:ok, _} = Rides.start_ride(r.id, d.id)
  end

  describe "the rate-limit table gone (its owner restarting)" do
    # (the table renamed away for the length of `fun`: as good as gone)
    defp table_gone(fun) do
      :ets.rename(Hoodride.RateLimit, :rate_limit_away)

      try do
        fun.()
      after
        :ets.rename(:rate_limit_away, Hoodride.RateLimit)
      end
    end

    test "limits let it through for that moment — nothing crashes" do
      table_gone(fn ->
        assert Throttle.take_message(9_200_000_001, 9_200_000_002) == :ok
        assert Throttle.give_back_message(9_200_000_001, 9_200_000_002) == :ok
        assert Throttle.take_new_conversation(9_200_000_001) == :ok
        assert Throttle.start_request_cooldown(9_200_000_001, 9_200_000_002) == :ok
        assert Throttle.request_cooldown(9_200_000_001, 9_200_000_002) == :ok
      end)
    end

    test "an error report is still answered (and logged)", %{conn: conn} do
      table_gone(fn ->
        assert post(conn, "/api/client-error", %{"kind" => "E", "message" => "m"}).status == 204
      end)
    end
  end

  describe "the database's supervisor restarting" do
    test "a lookup answers 'unavailable', as for a busy database" do
      u = user("rg-u1")

      without_name(Hoodride.Repo, fn ->
        assert Accounts.profile(u.id) == {:error, :unavailable}
        assert Accounts.has_car?(u.id) == {:error, :unavailable}
      end)

      assert %{id: _} = Accounts.profile(u.id)
    end

    test "/api/state answers 503 (the app retries), not 500", %{conn: conn} do
      u = user("rg-u2")
      friend = user("rg-u3")
      # a chat: the state names its partner — a database lookup
      {:ok, _} = Hoodride.Chat.send_message(%{id: friend.id, name: "f", photo: nil}, u.id, "hi")

      on_exit(fn ->
        Hoodride.Chat.delete_conversation(Hoodride.Chat.pair_key(u.id, friend.id))
      end)

      session = Hoodride.TestHelpers.session_for(u.id)

      without_name(Hoodride.Repo, fn ->
        assert json_response(get(init_test_session(conn, session), "/api/state"), 503) ==
                 %{"error" => "busy"}
      end)
    end

    test "any other RuntimeError is still a bug: raised" do
      refute Hoodride.Repo.down?(%RuntimeError{message: "something else"})
      assert Hoodride.Repo.down?(%DBConnection.ConnectionError{message: "x"})
    end
  end

  test "Erlang older than 28: a clear refusal to start, naming what's needed" do
    assert Hoodride.Application.check_otp!("28") == :ok
    assert Hoodride.Application.check_otp!("29") == :ok

    assert_raise RuntimeError, ~r/Erlang\/OTP 28 or newer/, fn ->
      Hoodride.Application.check_otp!("27")
    end
  end
end
