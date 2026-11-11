defmodule Hoodride.SchemaCheck do
  @moduledoc """
  At start-up, after the database changes run: can THIS version read every
  table it maps in code? If not, it refuses to start.

  Why (owner, 2026-11-11, reproduced): a new version's database change
  removed a column, the new version then failed, the deploy switched back —
  and the old version started, passed the deploy's check (which never reads
  accounts) and failed every sign-in. Refusing to start makes that loud:
  the deploy's check fails (and deploy.sh puts back the database copy).

  One empty read per table (`limit 0`): the database checks every column
  the read names, and returns nothing.
  """
  import Ecto.Query

  def child_spec(_),
    do: %{id: __MODULE__, start: {__MODULE__, :run, []}, restart: :temporary}

  @doc "`:ignore` (all readable: nothing to keep running) or `{:error, why}`."
  def run do
    Enum.find_value(schemas(), :ignore, fn schema ->
      try do
        Hoodride.Repo.all(from(s in schema, limit: 0))
        nil
      rescue
        e in Exqlite.Error -> {:error, {:database_unreadable, schema, Exception.message(e)}}
      end
    end)
  end

  @doc "Every table the app maps in code (an Ecto schema) — found, not listed."
  def schemas do
    {:ok, modules} = :application.get_key(:hoodride, :modules)

    for m <- modules,
        Code.ensure_loaded?(m),
        function_exported?(m, :__schema__, 1),
        m.__schema__(:source) != nil,
        do: m
  end
end
