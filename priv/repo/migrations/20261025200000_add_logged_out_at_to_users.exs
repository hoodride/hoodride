defmodule Hoodride.Repo.Migrations.AddLoggedOutAtToUsers do
  use Ecto.Migration

  # when the account last signed out (ms since epoch): every session and
  # socket token issued before it is refused (HoodrideWeb.Auth)
  def change do
    alter table(:users) do
      add :logged_out_at, :bigint
    end
  end
end
