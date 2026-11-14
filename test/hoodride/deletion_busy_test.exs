defmodule Hoodride.DeletionBusyTest do
  @moduledoc """
  Deleting an account could fail ("try again") under load (leftovers
  review, 2026-11-13). Its transaction READS the account, then deletes it.
  SQLite starts a transaction as a reader (DEFERRED, ecto_sqlite3's
  default): if another write is saved between that read and the delete,
  the delete can't wait its turn — its snapshot is stale — and fails at
  once, busy_timeout or not. Started IMMEDIATE, it holds the write lock
  from the start: the OTHER writer waits (busy_timeout) instead.

  The test database runs every test inside one transaction (the sandbox),
  so this is shown on a plain SQLite file — the same engine and settings —
  and the deletion is checked to start IMMEDIATE.
  """
  use ExUnit.Case, async: true

  alias Exqlite.Sqlite3

  setup do
    path = Path.join(System.tmp_dir!(), "deletion-busy-#{System.unique_integer([:positive])}.db")
    on_exit(fn -> Enum.each(["", "-wal", "-shm"], &File.rm(path <> &1)) end)
    {:ok, setup} = Sqlite3.open(path)
    :ok = Sqlite3.execute(setup, "PRAGMA journal_mode = WAL")
    :ok = Sqlite3.execute(setup, "CREATE TABLE users (id INTEGER PRIMARY KEY)")
    :ok = Sqlite3.execute(setup, "INSERT INTO users VALUES (1), (2)")
    :ok = Sqlite3.close(setup)

    open = fn ->
      {:ok, c} = Sqlite3.open(path)
      :ok = Sqlite3.execute(c, "PRAGMA busy_timeout = 300")
      c
    end

    %{deleter: open.(), other: open.()}
  end

  defp read(c), do: Sqlite3.execute(c, "SELECT count(*) FROM users")

  test "DEFERRED: a write saved between the read and the delete fails the deletion",
       %{deleter: d, other: o} do
    :ok = Sqlite3.execute(d, "BEGIN")
    :ok = read(d)
    # someone else's write lands meanwhile (a message, a sign-in)
    :ok = Sqlite3.execute(o, "INSERT INTO users VALUES (3)")
    assert {:error, msg} = Sqlite3.execute(d, "DELETE FROM users WHERE id = 1")
    assert msg =~ ~r/locked|busy/i
  end

  test "IMMEDIATE: the deletion goes through; the other write waits its turn",
       %{deleter: d, other: o} do
    :ok = Sqlite3.execute(d, "BEGIN IMMEDIATE")
    :ok = read(d)
    # (one process here: the other writer gives up after its wait — in the
    # app it would simply wait, then go through)
    assert {:error, _busy} = Sqlite3.execute(o, "INSERT INTO users VALUES (3)")
    assert :ok = Sqlite3.execute(d, "DELETE FROM users WHERE id = 1")
    assert :ok = Sqlite3.execute(d, "COMMIT")
    assert :ok = Sqlite3.execute(o, "INSERT INTO users VALUES (3)")
  end

  test "the account deletion starts its transaction IMMEDIATE" do
    src = File.read!("lib/hoodride/account_deletion.ex")
    [_, erase] = String.split(src, "defp erase(user_id) do", parts: 2)
    [erase | _] = String.split(erase, "\n  defp ", parts: 2)
    assert erase =~ "Repo.transaction("
    assert erase =~ "mode: :immediate"
  end
end
