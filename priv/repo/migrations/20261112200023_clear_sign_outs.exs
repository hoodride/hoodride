defmodule Hoodride.Repo.Migrations.ClearSignOuts do
  use Ecto.Migration

  # Sign-out records are no longer kept (the delete loop, owner 2026-11-12):
  # nothing read them since a live-connection pass names the sign-in it came
  # from (2026-11-08) — erasing the account's sign-ins refuses everything —
  # and a sign-in/delete loop piled them up, one per deletion, kept 30 days.
  # The rows go now (the privacy page no longer lists them). The TABLE
  # stays: the version before still writes and loads it (expand, then
  # contract — it can be dropped in a later release).
  # Never edit this file once it may have run in production: add a new one.
  def up do
    # excellent_migrations:safety-assured-for-next-line raw_sql_executed
    execute(clear_sql())
  end

  def down, do: :ok

  @doc false
  def clear_sql, do: "DELETE FROM sign_outs"
end
