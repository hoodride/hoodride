defmodule HoodrideWeb.ReconnectBurstTest do
  @moduledoc """
  After a restart everyone reconnects at once — and with sign-ins and
  blocks read ON DEMAND (owner, 2026-11-17: Hoodride.SessionTokens,
  Hoodride.Blocks), each of them now needs the database on the way in.
  The burst must still get EVERYONE in: every connect and every join
  succeeds, each person's sign-ins read ONCE and their blocks ONCE (never
  a read per join, per map update or per retry), nobody shown to someone
  they blocked. (The capacity test runs the same against the real build:
  ARCHITECTURE.md "Capacity".)
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest, only: [subscribe_and_join: 3]
  require Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.{Accounts, Blocks, SessionTokens}
  alias Hoodride.TestHelpers

  @people 150

  setup do
    TestHelpers.scrub_live_state()
    :ok
  end

  defp person(i) do
    key = "burst-#{i}"
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Accounts.agree_to_terms(u.id)
    %{"user_token" => raw} = TestHelpers.session_for(u.id)
    {:ok, info} = SessionTokens.lookup_as(raw, u.id)
    pass = HoodrideWeb.Auth.socket_token(%{id: u.id, name: key, photo: nil, token: info})
    %{id: u.id, pass: pass}
  end

  defp reads_of(table, fun) do
    me = self()
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ -> if meta.query =~ ~s("#{table}"), do: send(me, {:q, table}) end,
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

  # one app coming back: connect with its pass, join its user channel and
  # the map — then hold the connection until told (so the burst overlaps)
  defp come_back(p, test) do
    with {:ok, socket} <-
           Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
             connect_info: %{auth_token: p.pass},
             test_process: test
           ),
         {:ok, _, _} <- subscribe_and_join(socket, "user:#{p.id}", %{}),
         {:ok, _, _} <- subscribe_and_join(socket, "world", %{}) do
      send(test, {:in, p.id})

      receive do
        :done -> :ok
      after
        30_000 -> :ok
      end
    else
      other -> send(test, {:failed, p.id, other})
    end
  end

  test "a restart: #{@people} people back at once — all in; each one's sign-ins and blocks read once" do
    people = for i <- 1..@people, do: person(i)
    # everyone has blocked the next three (wrapping): every load has rows
    for {p, i} <- Enum.with_index(people), k <- 1..3 do
      other = Enum.at(people, rem(i + k, @people))
      :ok = Blocks.block(p.id, other.id)
    end

    :ok = SessionTokens.reset_memory()
    :ok = Blocks.reset_memory()
    test = self()

    {{pids, ms}, token_reads} =
      reads_of("user_tokens", fn ->
        t0 = System.monotonic_time(:millisecond)
        pids = for p <- people, do: spawn(fn -> come_back(p, test) end)

        for _ <- people do
          receive do
            {:in, _} -> :ok
            {:failed, id, why} -> flunk("#{id} didn't get back in: #{inspect(why)}")
          after
            30_000 -> flunk("the burst didn't finish in 30 s")
          end
        end

        {pids, System.monotonic_time(:millisecond) - t0}
      end)

    for pid <- pids, do: send(pid, :done)

    assert token_reads == @people, "sign-ins: one read per person (#{token_reads})"

    for p <- people do
      assert SessionTokens.loaded?(p.id)
      assert Blocks.loaded?(p.id)
    end

    # (a ceiling, not a benchmark: one database connection in tests)
    assert ms < 20_000, "#{@people} back in #{ms} ms"
  end

  test "the blocks of a burst: read once per person, however many joins" do
    people = for i <- 1..40, do: person(i + 1000)

    for {p, i} <- Enum.with_index(people) do
      other = Enum.at(people, rem(i + 1, 40))
      :ok = Blocks.block(p.id, other.id)
    end

    :ok = Blocks.reset_memory()
    test = self()

    {_, block_reads} =
      reads_of("blocks", fn ->
        pids = for p <- people, do: spawn(fn -> come_back(p, test) end)

        for _ <- people do
          receive do
            {:in, _} -> :ok
            {:failed, id, why} -> flunk("#{id}: #{inspect(why)}")
          after
            30_000 -> flunk("timeout")
          end
        end

        for pid <- pids, do: send(pid, :done)
      end)

    assert block_reads == 40, "one read per person (#{block_reads})"
  end
end
