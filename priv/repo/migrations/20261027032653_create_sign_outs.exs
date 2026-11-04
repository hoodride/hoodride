defmodule Hoodride.Repo.Migrations.CreateSignOuts do
  @moduledoc """
  Revocations get their own table (Hoodride.SignOuts). They used to live
  only in `users.logged_out_at` — deleted WITH the account, so after any
  restart a deleted account's leftover socket token (good for a day)
  connected again. One row per account (the latest sign-out or deletion),
  kept 30 days (the session lifetime: older ones refuse nothing still
  valid). No link to `users`: a deleted account's row must outlive it.
  """
  use Ecto.Migration

  def up do
    create table(:sign_outs, primary_key: false) do
      add :user_id, :integer, primary_key: true
      add :at, :integer, null: false
    end

    create index(:sign_outs, [:at])
    execute copy_sql()
  end

  def down, do: drop(table(:sign_outs))

  @doc false
  # today's sign-outs move over (start-up drops any older than 30 days)
  def copy_sql,
    do:
      "INSERT OR REPLACE INTO sign_outs (user_id, at) SELECT id, logged_out_at FROM users WHERE logged_out_at IS NOT NULL"
end
