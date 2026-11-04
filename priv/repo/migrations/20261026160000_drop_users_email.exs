defmodule Hoodride.Repo.Migrations.DropUsersEmail do
  use Ecto.Migration

  # Nothing used the email — the account is the provider's id — so it isn't
  # asked for (Google: `openid profile` only) or kept. Collect less.
  def up do
    alter table(:users) do
      remove :email
    end
  end

  def down do
    alter table(:users) do
      add :email, :string
    end
  end
end
