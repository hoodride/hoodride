defmodule HoodrideWeb.ConnCase do
  @moduledoc """
  This module defines the test case to be used by
  tests that require setting up a connection.

  Such tests rely on `Phoenix.ConnTest` and also
  import other functionality to make it easier
  to build common data structures and query the data layer.

  Finally, if the test case interacts with the database,
  we enable the SQL sandbox, so changes done to the database
  are reverted at the end of every test. If you are using
  PostgreSQL, you can even run database tests asynchronously
  by setting `use HoodrideWeb.ConnCase, async: true`, although
  this option is not recommended for other databases.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      # The default endpoint for testing
      @endpoint HoodrideWeb.Endpoint

      use HoodrideWeb, :verified_routes

      # Import conveniences for testing with connections
      import Plug.Conn
      import Phoenix.ConnTest
      import HoodrideWeb.ConnCase
    end
  end

  # `@moduletag db: false`: a test that never touches the database doesn't
  # take its ONE connection (config/test.exs) — a slow one holding it made
  # the tests queued behind it give up (owner, 2026-11-05: the sitemap's
  # page walks, 20 s each, dropped nine). Touching it anyway fails at once:
  # no connection is checked out for it.
  setup tags do
    if tags[:db] != false, do: Hoodride.DataCase.setup_sandbox(tags)
    {:ok, conn: Phoenix.ConnTest.build_conn()}
  end
end
