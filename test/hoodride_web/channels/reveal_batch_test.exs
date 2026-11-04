defmodule HoodrideWeb.RevealBatchTest do
  @moduledoc """
  The pile list asks for the names of the rows on screen in ONE reveal
  (`%{"ids" => [...]}`), the DataLoader pattern. Before, every row asked
  alone; the rows over the budget all retried together on a flat 2 s and
  were mostly refused again.

  A batch costs one allowance PER NAME, like single reveals: a batch must
  not make scraping names cheaper. Each id gets the same privacy check and
  the same refusal as a single reveal. When the budget runs out mid-batch,
  the rest come back as `later` with `retry_ms` — the exact wait — so the
  app keeps one queue and one timer (priv/static/reveal_queue.js).
  """
  use ExUnit.Case

  alias Hoodride.{Geo, TestClient}
  import TestClient, only: [request: 4]

  @cell "882a1072c7fffff"
  @cell2 "882a1072cffffff"

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "dev",
        provider_id: key,
        name: key,
        photo: "https://example.test/#{key}.png"
      })

    u
  end

  defp car(key, cell) do
    u = user(key)
    Geo.driver_update(%{id: u.id, name: u.name, photo: u.photo}, cell, nil)
    u
  end

  defp watching(key, cell) do
    rider = TestClient.start(String.to_atom(key), user(key))
    assert {:ok, _} = request(rider, "world", "sync", %{"geo" => [cell]})
    rider
  end

  defp reveal(client, ids), do: request(client, "world", "reveal", %{"ids" => ids})

  test "the names on screen in one request; anyone else gets the same refusal" do
    a = car("rb-a", @cell)
    b = car("rb-b", @cell)
    elsewhere = car("rb-x", @cell2)
    rider = watching("rb-r", @cell)

    assert {:ok, %{users: users, unavailable: unavailable, later: []}} =
             reveal(rider, [a.id, elsewhere.id, b.id, 12_345])

    assert Enum.sort_by(users, & &1.id) ==
             Enum.sort_by(
               [
                 # a rider looking at cars: each car too (none set here)
                 %{id: a.id, name: "rb-a", photo: "https://example.test/rb-a.png", car: nil},
                 %{id: b.id, name: "rb-b", photo: "https://example.test/rb-b.png", car: nil}
               ],
               & &1.id
             )

    assert Enum.sort(unavailable) == Enum.sort([elsewhere.id, 12_345])
  end

  test "each name costs one allowance — a batch is no cheaper than taps" do
    rider = watching("rb-r", @cell)
    # spent: 1 sync + 20 names = the whole burst (WorldChannel: 20 + 1)
    assert {:ok, %{later: []}} = reveal(rider, Enum.to_list(1..20))

    assert {:error, %{reason: "rate_limited"}} =
             request(rider, "world", "sync", %{"geo" => [@cell]})
  end

  test "out of budget mid-batch: the rest come back as `later` with the exact wait" do
    a = car("rb-a", @cell)
    rider = watching("rb-r", @cell)
    assert {:ok, %{later: []}} = reveal(rider, Enum.to_list(1..19))

    assert {:ok, %{users: users, unavailable: unavailable, later: later, retry_ms: wait}} =
             reveal(rider, [a.id, 101, 102, 103])

    assert [%{id: a_id}] = users
    assert a_id == a.id
    assert unavailable == []
    assert later == [101, 102, 103], "the unanswered ones, in the order asked"
    assert wait > 0 and wait <= 1_000, "the wait until the next name fits (60/min)"
  end

  test "an id asked twice in one batch is answered (and charged) once" do
    a = car("rb-a", @cell)
    rider = watching("rb-r", @cell)
    assert {:ok, %{users: [_], unavailable: []}} = reveal(rider, [a.id, a.id, a.id])
    # 1 sync + 1 name spent: 19 more names fit
    assert {:ok, %{later: []}} = reveal(rider, Enum.to_list(1..19))
  end

  test "more ids than the burst is refused whole, and costs nothing" do
    rider = watching("rb-r", @cell)

    assert {:error, %{reason: "too_many"}} =
             reveal(rider, Enum.to_list(1..(HoodrideWeb.WorldChannel.reveal_max() + 1)))

    assert {:ok, %{later: []}} = reveal(rider, Enum.to_list(1..20))
  end

  test "garbage in a batch: each is the same refusal, and the channel lives on" do
    a = car("rb-a", @cell)
    rider = watching("rb-r", @cell)
    garbage = [-1, 0, 1.5, 2 ** 70, "12", "", nil, [], %{}, true]

    assert {:ok, %{users: [], unavailable: unavailable, later: []}} = reveal(rider, garbage)
    assert length(unavailable) == length(garbage)

    for payload <- [%{"ids" => "x"}, %{"ids" => nil}, %{"ids" => %{}}] do
      assert {:error, %{reason: "unavailable"}} = request(rider, "world", "reveal", payload)
    end

    assert {:ok, %{users: [%{name: "rb-a"}]}} = reveal(rider, [a.id])
  end

  test "a single reveal refused for speed says how long to wait too" do
    rider = watching("rb-r", @cell)
    for i <- 1..20, do: request(rider, "world", "reveal", %{"id" => i})

    assert {:error, %{reason: "rate_limited", retry_ms: wait}} =
             request(rider, "world", "reveal", %{"id" => 1})

    assert wait > 0
  end

  describe "the database can't answer right now (busy), which is not the same as gone" do
    setup do
      on_exit(fn -> Application.delete_env(:hoodride, :user_lookup) end)
    end

    # the lookup fails for `busy` ids as an overloaded pool does; others are real
    defp busy_for(busy) do
      Application.put_env(:hoodride, :user_lookup, fn id ->
        if id in busy,
          do: raise(DBConnection.ConnectionError, "connection not available"),
          else: Hoodride.Accounts.get_user(id)
      end)
    end

    test "the database busy: every name asked comes back LATER with the pool's own wait" do
      a = car("rb-ba", @cell)
      b = car("rb-bb", @cell)
      c = car("rb-bc", @cell)
      rider = watching("rb-br", @cell)
      busy_for([b.id])

      assert {:ok, %{users: [], unavailable: [], later: later, retry_ms: wait}} =
               reveal(rider, [a.id, b.id, c.id])

      # ONE lookup for the batch, so it fails as one; not "unavailable"
      # (that reads "Not available" for good): all asked again, in order
      assert later == [a.id, b.id, c.id]
      assert wait == HoodrideWeb.WorldChannel.busy_wait_ms()
    end

    test "names someone may not see are refused even when the database is busy" do
      a = car("rb-bj", @cell)
      elsewhere = car("rb-bk", @cell2)
      rider = watching("rb-bl", @cell)
      busy_for([a.id])

      assert {:ok, %{users: [], unavailable: [x], later: [y]}} =
               reveal(rider, [elsewhere.id, a.id])

      assert {x, y} == {elsewhere.id, a.id}
    end

    test "once the database answers again, the same names come back" do
      a = car("rb-bd", @cell)
      rider = watching("rb-be", @cell)
      busy_for([a.id])
      assert {:ok, %{later: [id]}} = reveal(rider, [a.id])
      busy_for([])
      assert {:ok, %{users: [%{name: "rb-bd"}]}} = reveal(rider, [id])
    end

    test "an account that's really gone is still unavailable" do
      gone = car("rb-bf", @cell)
      rider = watching("rb-bg", @cell)
      busy_for([])
      Hoodride.Repo.delete!(Hoodride.Accounts.get_user(gone.id))
      assert {:ok, %{unavailable: [id], later: []}} = reveal(rider, [gone.id])
      assert id == gone.id
    end

    test "a single tap on a busy database says busy, with the wait — not 'gone'" do
      a = car("rb-bh", @cell)
      rider = watching("rb-bi", @cell)
      busy_for([a.id])

      assert {:error, %{reason: "busy", retry_ms: wait}} =
               request(rider, "world", "reveal", %{"id" => a.id})

      assert wait == HoodrideWeb.WorldChannel.busy_wait_ms()
    end

    test "the wait is the database pool's own patience (queue_target), not a made-up number" do
      old = Application.get_env(:hoodride, Hoodride.Repo)
      on_exit(fn -> Application.put_env(:hoodride, Hoodride.Repo, old) end)
      Application.put_env(:hoodride, Hoodride.Repo, Keyword.put(old, :queue_target, 1234))
      assert HoodrideWeb.WorldChannel.busy_wait_ms() == 1234
    end
  end

  test "the app's batch size is the server's limit" do
    js = File.read!(Path.join([:code.priv_dir(:hoodride), "static", "reveal_queue.js"]))
    [_, max] = Regex.run(~r/const MAX = (\d+);/, js)
    assert String.to_integer(max) == HoodrideWeb.WorldChannel.reveal_max()
  end
end
