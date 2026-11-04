defmodule Hoodride.Repo.Migrations.AddCarToUsers do
  use Ecto.Migration

  # "Your car" (ARCHITECTURE.md): what riders look for — colour, make,
  # model. No plate (owner's choice). Empty until a driver sets it.
  def change do
    alter table(:users) do
      add :car_color, :string
      add :car_make, :string
      add :car_model, :string
    end
  end
end
