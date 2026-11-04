defmodule Hoodride.Repo.Migrations.IndexUsersLoggedOutAt do
  use Ecto.Migration

  # the start-up load of recent sign-outs (Hoodride.SignOuts.load/1) reads
  # by logged_out_at: an index keeps it fast however many users there are
  def change do
    create index(:users, [:logged_out_at])
  end
end
