defmodule Hoodride.AccountsTest do
  @moduledoc """
  Random ids and the two insert clashes. The id source is injectable, so
  each clash is forced deterministically instead of hoped for.
  """
  use Hoodride.DataCase

  alias Hoodride.Accounts

  defp attrs(key), do: %{provider: "dev", provider_id: key, name: key}

  test "a taken random id is retried with a fresh one" do
    {:ok, existing} = Accounts.upsert_oauth_user(attrs("first"))
    fresh = Accounts.random_id()
    {:ok, draws} = Agent.start_link(fn -> [existing.id, fresh] end)
    next = fn -> Agent.get_and_update(draws, fn [h | t] -> {h, t} end) end

    assert {:ok, user} = Accounts.upsert_oauth_user(attrs("second"), next)
    assert user.id == fresh
    assert Accounts.get_user(existing.id).provider_id == "first"
  end

  test "a parallel first login of the SAME person returns that person (no crash, no dup)" do
    # the other login lands between our lookup and our insert: the id
    # source runs exactly there, so it plays the other tab
    other_tab = fn ->
      {:ok, _} = Accounts.upsert_oauth_user(attrs("twice"))
      Accounts.random_id()
    end

    assert {:ok, user} = Accounts.upsert_oauth_user(attrs("twice"), other_tab)
    assert user.provider_id == "twice"
    assert Repo.aggregate(Hoodride.Accounts.User, :count) == 1
  end

  test "REAL simultaneous first logins of one person: every one gets that person (no crash)" do
    # the same race with no hook at all — several processes really logging
    # in as the same new person at the same instant (a double tap, two
    # tabs). Find-then-insert lets more than one find nobody; before the
    # fix the loser got {:error, changeset} and dev_login crashed (500).
    for round <- 1..25 do
      key = "race-#{round}"

      tasks =
        for _ <- 1..6 do
          Task.async(fn ->
            receive do: (:go -> :ok)
            Accounts.upsert_oauth_user(attrs(key))
          end)
        end

      Enum.each(tasks, &send(&1.pid, :go))
      results = Enum.map(tasks, &Task.await/1)

      assert Enum.all?(results, &match?({:ok, _}, &1)),
             "round #{round}: #{inspect(Enum.reject(results, &match?({:ok, _}, &1)))}"

      assert results |> Enum.map(fn {:ok, u} -> u.id end) |> Enum.uniq() |> length() == 1
    end
  end

  test "ids stay inside JavaScript's exact-integer range" do
    for _ <- 1..1_000 do
      id = Accounts.random_id()
      assert id > 4_294_967_296 and id <= 9_007_199_254_740_991
    end
  end
end
