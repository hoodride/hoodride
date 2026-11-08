defmodule Hoodride.Repo.Migrations.CreateUserTokens do
  use Ecto.Migration

  # Sign-in tokens, as Phoenix's own sign-in (phx.gen.auth): one row per
  # signed-in device; the cookie holds the random token, this table only its
  # SHA-256 (Hoodride.SessionTokens). Deleting the account deletes its rows.
  # Never edit this file once it may have run in production: add a new one.
  def change do
    create table(:user_tokens) do
      add :user_id, references(:users, on_delete: :delete_all), null: false
      add :token_hash, :binary, null: false
      add :context, :string, null: false
      # ms since 1970: when this token was made (valid 30 days, replaced
      # after 7 while in use), and when the person really signed in (a
      # year at most, carried over to each replacement)
      add :inserted_at, :integer, null: false
      add :authenticated_at, :integer, null: false
    end

    create unique_index(:user_tokens, [:token_hash])
    create index(:user_tokens, [:user_id])
  end
end
