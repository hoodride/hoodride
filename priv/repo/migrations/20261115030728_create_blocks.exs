defmodule Hoodride.Repo.Migrations.CreateBlocks do
  use Ecto.Migration

  # Blocks (owner, 2026-11-15 — Hoodride.Blocks): one row per "Ann blocked
  # Bob". Either way, the two don't see each other on the map and can't
  # message or ask each other for a ride. Kept until unblocked or either
  # account is deleted (its rows go with it). Only who and when — never why.
  # Never edit this file once it may have run in production: add a new one.
  def change do
    create table(:blocks) do
      add :blocker_id, references(:users, on_delete: :delete_all), null: false
      add :blocked_id, references(:users, on_delete: :delete_all), null: false
      # ms since 1970: newest first in the Blocked people list
      add :inserted_at, :integer, null: false
    end

    # once per pair and direction; "who blocked me" found by its own index
    create unique_index(:blocks, [:blocker_id, :blocked_id])
    create index(:blocks, [:blocked_id])
  end
end
