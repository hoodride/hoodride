defmodule Hoodride.MigrationSafetyTest do
  @moduledoc """
  Expand, then contract (owner, 2026-11-11): no database change the version
  before couldn't run on. A deploy that fails switches back to the version
  before (deploy/switch.sh) — reproduced: one that removed a column left the
  old version failing every sign-in. excellent_migrations checks every new
  change in the precommit; these pin what it catches, with this project's
  settings (config :excellent_migrations).
  """
  use ExUnit.Case, async: true

  setup do
    dir = Path.join(System.tmp_dir!(), "hr_migsafety_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(dir) end)
    %{dir: dir}
  end

  defp check(ctx, body) do
    path = Path.join(ctx.dir, "20990101000000_change.exs")

    File.write!(path, """
    defmodule Hoodride.Repo.Migrations.Change do
      use Ecto.Migration

      def change do
    #{body}
      end
    end
    """)

    case ExcellentMigrations.Runner.check_migrations(migrations_paths: [path]) do
      :safe -> :safe
      {:dangerous, dangers} -> Enum.map(dangers, & &1.type)
    end
  end

  test "the change reproduced (a column moved: the old one removed): caught", ctx do
    assert :column_removed in check(ctx, """
               alter table(:users) do
                 add :car, :string
                 remove :car_make
               end
           """)
  end

  test "each change the version before can't run on: caught", ctx do
    assert :column_renamed in check(ctx, "    rename table(:users), :name, to: :first_name")

    assert :column_type_changed in check(ctx, """
               alter table(:users) do
                 modify :name, :text
               end
           """)

    assert :table_dropped in check(ctx, "    drop table(:sign_outs)")
    assert :table_renamed in check(ctx, "    rename table(:sign_outs), to: table(:logouts)")
    # raw SQL could do any of them
    assert :raw_sql_executed in check(ctx, ~s[    execute "ALTER TABLE users DROP COLUMN name"])
  end

  test "the expand step — a new column, a new table, an index: allowed", ctx do
    assert check(ctx, """
               alter table(:users) do
                 add :car, :string
               end
           """) == :safe

    assert check(ctx, """
               create table(:trips) do
                 add :user_id, :integer
               end
           """) == :safe

    # (the Postgres locking checks are off: SQLite has none of that)
    assert check(ctx, "    create index(:users, [:name])") == :safe
  end

  test "it runs in the precommit, and the changes already shipped aren't rechecked" do
    precommit = Mix.Project.config()[:aliases][:precommit]
    assert "excellent_migrations.check_safety" in precommit

    assert Enum.find_index(precommit, &(&1 == "excellent_migrations.check_safety")) <
             Enum.find_index(precommit, &(&1 == "test"))

    # (only shipped changes are skipped: start_after is never past the last one)
    newest = "priv/repo/migrations" |> File.ls!() |> Enum.max() |> binary_part(0, 14)
    assert Application.get_env(:excellent_migrations, :start_after) <= newest
  end
end
