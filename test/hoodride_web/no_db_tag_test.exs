defmodule HoodrideWeb.NoDbTagTest do
  @moduledoc """
  `@moduletag db: false` (HoodrideWeb.ConnCase): the test takes no
  database connection — the ONE the test database has stays free for the
  tests that need it (owner, 2026-11-05: slow page walks holding it made
  nine queued tests give up). Proof it's really not taken: a query fails.
  """
  use HoodrideWeb.ConnCase, async: true

  @moduletag db: false

  test "a test marked db: false holds no connection: a query is refused" do
    assert_raise DBConnection.OwnershipError, fn ->
      Hoodride.Repo.query!("SELECT 1")
    end
  end

  # every async test that would take the ONE connection: none but these
  # (precommit, 2026-11-22: seven page tests held it, each made slow by the
  # whole suite running, and a test queued 13.6 s behind them was dropped).
  # A new async test that needs the database: short, and listed here — or
  # with the sync tests (async: false), where nobody waits on it
  # (none today: each one listed with why)
  @may_hold %{}

  # Does this test file, run async, take the connection? (review, 2026-11-22)
  # - ConnCase: yes, unless `@moduletag db: false` (its setup honors it)
  # - DataCase: always — its setup ignores `db: false`
  # - any file checking the sandbox out by hand (Sandbox.checkout/start_owner)
  # "async" read from the `use` however it's written (options in any order,
  # over several lines)
  @doc false
  def holds_async?(src) do
    # `async: true` among the options of a `use`, on its line or the
    # indented lines after it
    async = Regex.match?(~r/use\s+[\w.]+\s*,[^\n]*(?:\n[ \t]+[^\n]*)*?async:\s*true/, src)
    conn = Regex.match?(~r/use\s+HoodrideWeb\.ConnCase\b/, src)
    data = Regex.match?(~r/use\s+Hoodride\.DataCase\b/, src)
    by_hand = Regex.match?(~r/Sandbox\.(checkout|start_owner!?)\(/, src)
    tagged = src =~ "@moduletag db: false"
    async and ((conn and not tagged) or data or by_hand)
  end

  test "the rule: which async files take the connection" do
    # (each case as a file would be written)
    assert holds_async?("use HoodrideWeb.ConnCase, async: true\n")
    refute holds_async?("use HoodrideWeb.ConnCase, async: true\n  @moduletag db: false\n")
    refute holds_async?("use HoodrideWeb.ConnCase, async: false\n")
    refute holds_async?("use HoodrideWeb.ConnCase\n")
    # DataCase ignores the tag
    assert holds_async?("use Hoodride.DataCase, async: true\n  @moduletag db: false\n")
    # by hand, in a plain ExUnit.Case
    by_hand = "  setup do\n    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)\n"
    assert holds_async?("use ExUnit.Case, async: true\n" <> by_hand)
    refute holds_async?("use ExUnit.Case\n" <> by_hand)
    # however the `use` is written
    assert holds_async?("use HoodrideWeb.ConnCase, foo: 1, async: true\n")
    assert holds_async?("use HoodrideWeb.ConnCase,\n    async: true\n")
  end

  test "async tests take the database's one connection only when listed" do
    holders =
      for path <- Path.wildcard("test/**/*_test.exs"),
          # (this file names the rule's own examples)
          path != "test/hoodride_web/no_db_tag_test.exs",
          holds_async?(File.read!(path)),
          do: path

    assert Enum.sort(holders) == Enum.sort(Map.keys(@may_hold)),
           "async tests holding the one connection: #{inspect(holders -- Map.keys(@may_hold))} " <>
             "— tag `@moduletag db: false` (ConnCase, pages only), or `async: false`, or list it with why"
  end
end
