defmodule Hoodride.SandboxTimeTest do
  @moduledoc """
  A test holds its database connection as long as the test itself may run
  (owner, 2026-11-05: the languages journey, allowed 3 minutes, lost its
  connection at Ecto's 2). Ecto: raise it for long-running tests only.
  """
  use ExUnit.Case, async: true

  import Hoodride.DataCase, only: [ownership_timeout: 1]

  test "a long test keeps its connection as long as it may run" do
    assert ownership_timeout(%{timeout: 180_000}) == 180_000
    assert ownership_timeout(%{timeout: 300_000}) == 300_000
    assert ownership_timeout(%{timeout: :infinity}) == :infinity
  end

  test "every other test: Ecto's own 2 minutes, never less" do
    assert ownership_timeout(%{}) == 120_000
    assert ownership_timeout(%{timeout: 120_000}) == 120_000
    assert ownership_timeout(%{timeout: 5_000}) == 120_000
  end

  test "the setup really passes it on (not just works it out)" do
    source = File.read!("test/support/data_case.ex")
    [_, setup] = String.split(source, "def setup_sandbox(tags) do", parts: 2)
    [setup | _] = String.split(setup, "\n  end\n", parts: 2)
    assert setup =~ "ownership_timeout: ownership_timeout(tags)"
  end
end
