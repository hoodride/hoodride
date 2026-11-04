defmodule Hoodride.TestDbQueueTest do
  # The test database has ONE connection (config/test.exs: SQLite is
  # single-writer) and every test holds it for its whole run, so on a busy
  # machine the others queue for seconds. A wait is fine; being DROPPED from
  # the queue is a failure that says nothing about the code (2026-11-02: three
  # tests, after 2.1 s, 2.8 s and 4.9 s, while the owner ran other work).
  # DBConnection drops a checkout once waits pass twice queue_target.
  use ExUnit.Case, async: false

  alias Ecto.Adapters.SQL.Sandbox

  test "a checkout that waits 6 s for the one connection gets it, not dropped" do
    me = self()

    _holder =
      spawn_link(fn ->
        owner = Sandbox.start_owner!(Hoodride.Repo)
        send(me, :holding)
        # hold it as a slow test would, then let go
        receive do
          :release -> :ok
        after
          6_000 -> :ok
        end

        Sandbox.stop_owner(owner)
        send(me, :released)
      end)

    assert_receive :holding, 5_000
    started = System.monotonic_time(:millisecond)
    owner = Sandbox.start_owner!(Hoodride.Repo)
    waited = System.monotonic_time(:millisecond) - started
    Sandbox.stop_owner(owner)

    assert_receive :released, 8_000
    assert waited >= 5_500, "it should have waited for the holder (waited #{waited} ms)"
  end
end
