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

  # each test its own folder, emptied before it starts (ExUnit's tmp_dir):
  # a file left by an earlier run never meets this one. (It was the system
  # temp folder, numbered System.unique_integer — unique within ONE run
  # only — and never deleted: its connections stayed open, and Windows
  # can't delete an open file. A later run drew a number already used and
  # found the old table — "table users already exists", 2026-11-22)
  @moduletag :tmp_dir

  setup %{tmp_dir: dir} do
    path = Path.join(dir, "deletion-busy.db")
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

    deleter = open.()
    other = open.()
    on_exit(fn -> Enum.each([deleter, other], &Sqlite3.close/1) end)
    %{deleter: deleter, other: other}
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
