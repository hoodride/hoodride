defmodule HoodrideWeb.BlocksApiTest do
  @moduledoc """
  Blocks in the app's answers (owner, 2026-11-15): `/api/state` says how
  many you've blocked (the "Blocked people" link at the bottom of the
  profile drawer shows only then) and never lists a chat or request with
  someone blocked either way (a block ends them — a safety net);
  `GET /api/blocks` is the list, newest first, name and photo only.
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

  # (asked as the profile drawer opens — never with every app open, which
  # makes one database query: owner, 2026-11-17)
  defp count(u), do: json_response(get(signed_in(u), "/api/blocks?count=1"), 200)["count"]

  test "how many you've blocked: 0, then the count" do
    [ann, bob, cat] = [user("ba-ann"), user("ba-bob"), user("ba-cat")]
    assert count(ann) == 0
    :ok = Blocks.block(ann.id, bob.id)
    :ok = Blocks.block(ann.id, cat.id)
    assert count(ann) == 2
    # being blocked isn't counted (nor said)
    assert count(bob) == 0
    refute Map.has_key?(state(ann), "blocked"), "not with every app open"
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
