defmodule Hoodride.SchemaCheckTest do
  @moduledoc """
  A version must not start on a database it can't read (owner, 2026-11-11).
  Reproduced: a new version's database change removed a column, the new
  version then failed, the deploy switched back — and the old version
  STARTED, passed the deploy's check (it never reads accounts), and every
  sign-in failed ("no such column: u0.car_make"). Now it refuses to start:
  the deploy's check fails loudly instead of passing.
  """
  use ExUnit.Case

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
  end

  test "a database this version can read: the check passes (nothing started)" do
    assert Hoodride.SchemaCheck.run() == :ignore
  end

  test "a column this version reads, gone (a newer version's change): it refuses to start, naming it" do
    Hoodride.Repo.query!("ALTER TABLE users DROP COLUMN car_make")

    assert {:error, {:database_unreadable, Hoodride.Accounts.User, message}} =
             Hoodride.SchemaCheck.run()

    assert message =~ "car_make"
  end

  test "every table the app maps in code is checked (a new one included without a list to keep)" do
    assert Hoodride.Accounts.User in Hoodride.SchemaCheck.schemas()
  end

  test "it runs at start-up: after the database changes, before anything reads the database" do
    src = File.read!("lib/hoodride/application.ex")
    migrator = :binary.match(src, "{Ecto.Migrator,") |> elem(0)
    check = :binary.match(src, "Hoodride.SchemaCheck,") |> elem(0)
    sign_outs = :binary.match(src, "      Hoodride.SignOuts,") |> elem(0)
    assert migrator < check and check < sign_outs
  end
end
