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
end
