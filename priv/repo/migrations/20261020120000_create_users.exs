defmodule Hoodride.Repo.Migrations.CreateUsers do
  use Ecto.Migration

  def change do
    create table(:users) do
      add :provider, :string, null: false
      add :provider_id, :string, null: false
      add :name, :string, null: false
      add :email, :string
      add :photo, :string

      timestamps()
    end

    create unique_index(:users, [:provider, :provider_id])
  end
end
