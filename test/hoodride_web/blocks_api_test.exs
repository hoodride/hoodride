defmodule HoodrideWeb.BlocksApiTest do
  @moduledoc """
  Blocks in the app's answers (owner, 2026-11-15): `GET /api/blocks` is
  the list, newest first, name and photo only — asked only when the
  "Blocked people" link (always at the bottom of the profile drawer, owner
  2026-11-18) is tapped. No count anywhere: nothing needs one.
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Blocks}

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Accounts.agree_to_terms(u.id)
    Accounts.get_user(u.id)
  end

  defp signed_in(u) do
    session =
      Hoodride.TestHelpers.session_for(u.id) |> Map.put("terms_version", Hoodride.Terms.version())

    init_test_session(build_conn(), session)
  end

  defp state(u), do: json_response(get(signed_in(u), "/api/state?chats=list"), 200)

  # (owner, 2026-11-18: the link is always there, so the count it once
  # waited on is gone — an old app asking for it gets the list, never an
  # error, and being blocked is said nowhere)
  test "no count: '?count=1' is just the list; nothing in the app's state" do
    [ann, bob] = [user("ba-ann"), user("ba-bob")]
    :ok = Blocks.block(ann.id, bob.id)
    body = json_response(get(signed_in(ann), "/api/blocks?count=1"), 200)
    refute Map.has_key?(body, "count")
    assert Enum.map(body["blocked"], & &1["name"]) == ["ba-bob"]
    refute Map.has_key?(json_response(get(signed_in(bob), "/api/blocks?count=1"), 200), "count")
    refute Map.has_key?(state(ann), "blocked"), "not with every app open"
  end

  # (cross-feature review round 11, 2026-11-25) one person: do I block them?
  # — the app settles a Block whose answers were lost. Only your own blocks
  test "?peer=<id>: do I block them — mine only, either way" do
    [ann, bob, cat] = [user("bp-ann"), user("bp-bob"), user("bp-cat")]
    :ok = Blocks.block(ann.id, bob.id)

    assert json_response(get(signed_in(ann), "/api/blocks?peer=#{bob.id}"), 200) == %{
             "blocking" => true
           }

    assert json_response(get(signed_in(ann), "/api/blocks?peer=#{cat.id}"), 200) == %{
             "blocking" => false
           }

    # (Bob is blocked BY Ann: he doesn't block her)
    assert json_response(get(signed_in(bob), "/api/blocks?peer=#{ann.id}"), 200) == %{
             "blocking" => false
           }

    assert json_response(get(signed_in(ann), "/api/blocks?peer=x"), 400)["error"] == "bad_peer"
    # (not a plain id — a map, a list, past 64 bits: refused, never a crash
    # or a list joined into another id — round 12)
    for q <- ["peer[a]=1", "peer[]=1&peer[]=2", "peer=99999999999999999999999", "peer=-1"] do
      assert json_response(get(signed_in(ann), "/api/blocks?" <> q), 400)["error"] == "bad_peer",
             q
    end
  end

  test "the list: who you blocked, newest first, name and photo only" do
    [ann, bob, cat] = [user("ba3-ann"), user("ba3-bob"), user("ba3-cat")]
    :ok = Blocks.block(ann.id, bob.id)
    :ok = Blocks.block(ann.id, cat.id)
    body = json_response(get(signed_in(ann), "/api/blocks"), 200)
    assert Enum.map(body["blocked"], & &1["name"]) == ["ba3-cat", "ba3-bob"]
    assert Enum.all?(body["blocked"], &(Map.keys(&1) |> Enum.sort() == ["id", "name", "photo"]))
    assert json_response(get(signed_in(bob), "/api/blocks"), 200)["blocked"] == []
  end

  # (owner, 2026-11-15) in pages, as the chat list: the newest first, older
  # ones as the list is scrolled — "older than this one", not "page 2"
  describe "in pages" do
    defp blocks_page(u, cursor \\ nil) do
      q = if cursor, do: "?before=" <> URI.encode_www_form(cursor), else: ""
      json_response(get(signed_in(u), "/api/blocks" <> q), 200)
    end

    # `n` blocked, a millisecond apart: the first the oldest
    defp blocked_many(ann, n, key) do
      now = System.system_time(:millisecond)

      for i <- 1..n do
        u = user("#{key}-#{i}")

        Hoodride.Repo.query!(
          "INSERT INTO blocks (blocker_id, blocked_id, inserted_at) VALUES (?, ?, ?)",
          [ann.id, u.id, now - (n - i)]
        )

        u
      end
    end

    test "the newest page first, then the rest; nothing twice, nothing missed" do
      ann = user("pgb-ann")
      page = Hoodride.Limits.blocks_page()
      them = blocked_many(ann, page + 5, "pgb")

      first = blocks_page(ann)
      assert length(first["blocked"]) == page
      assert is_binary(first["more"])
      second = blocks_page(ann, first["more"])
      assert second["more"] == nil
      ids = Enum.map(first["blocked"] ++ second["blocked"], & &1["id"])
      assert ids == them |> Enum.reverse() |> Enum.map(& &1.id)
    end

    test "an unblock while scrolling: no duplicate, no gap" do
      ann = user("pgb2-ann")
      page = Hoodride.Limits.blocks_page()
      them = blocked_many(ann, page + 5, "pgb2")
      first = blocks_page(ann)
      # the newest one unblocked meanwhile
      :ok = Blocks.unblock(ann.id, List.last(them).id)
      second = blocks_page(ann, first["more"])
      ids = Enum.map(first["blocked"] ++ second["blocked"], & &1["id"])
      assert length(ids) == length(Enum.uniq(ids))
      assert MapSet.subset?(MapSet.new(Enum.map(Enum.drop(them, -1), & &1.id)), MapSet.new(ids))
    end

    test "a cursor that isn't one: 400" do
      ann = user("pgb3-ann")

      for bad <- ["", "x", "1.2.3", "-1.5", "99999999999999999999999.1"] do
        conn = get(signed_in(ann), "/api/blocks?before=" <> URI.encode_www_form(bad))
        assert conn.status == 400, inspect(bad)
      end
    end
  end

  test "signed out: 401" do
    assert get(build_conn(), "/api/blocks").status == 401
  end
end
