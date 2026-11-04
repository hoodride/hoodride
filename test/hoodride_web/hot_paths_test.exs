defmodule HoodrideWeb.HotPathsTest do
  @moduledoc """
  The database off the busiest paths (after a restart thousands of apps ask
  at once, and the pool has 5 connections):

    * WHO YOU ARE needs no database read: the session carries the name,
      photo and provider from sign-in (they change only at sign-in, which
      always makes a new session), and whether you signed out or were
      deleted since is the in-memory denylist (Hoodride.SignOuts — kept in
      its own table, so it survives restarts). A session from before this
      carried nothing: checked the old way, once.
    * The people `/api/state` and reveal mention are looked up in ONE query,
      not one per person.

  Revocation must still bite with no database read (CVE-2026-86533: a
  library reloaded the user but never checked the revocation record).
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Chat, Geo, Repo, Requests, SignOuts, TestClient}

  @cell "882a1072c7fffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key, photo \\ nil) do
    {:ok, u} =
      Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key, photo: photo})

    u
  end

  # what signing in puts in the session now (HoodrideWeb.Auth.sign_in/2)
  defp signed_in(conn, u, at \\ System.system_time(:millisecond)) do
    init_test_session(conn, %{
      user_id: u.id,
      signed_in_at: at,
      name: u.name,
      photo: u.photo,
      provider: u.provider,
      terms_version: Hoodride.Terms.version()
    })
  end

  # how many database queries `fun` makes (Ecto's telemetry)
  defp queries(fun) do
    me = self()
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ -> send(me, {:query, meta.query}) end,
      nil
    )

    try do
      result = fun.()
      {result, collect([])}
    after
      :telemetry.detach(id)
    end
  end

  defp collect(acc) do
    receive do
      {:query, q} -> collect([q | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  describe "who you are, with no database read" do
    test "a signed-in request reads nothing from the database", %{conn: conn} do
      u = user("hp-a", "/p.png")
      conn = signed_in(conn, u)
      {res, qs} = queries(fn -> get(conn, "/api/me") end)

      assert json_response(res, 200)["user"] == %{
               "id" => u.id,
               "name" => "hp-a",
               "photo" => "/p.png",
               "provider" => "dev"
             }

      assert qs == []
    end

    test "signing in puts name, photo and provider in the session" do
      u = user("hp-si", "/x.png")

      conn =
        Phoenix.ConnTest.build_conn() |> init_test_session(%{}) |> HoodrideWeb.Auth.sign_in(u)

      assert get_session(conn, :name) == "hp-si"
      assert get_session(conn, :photo) == "/x.png"
      assert get_session(conn, :provider) == "dev"
    end

    test "signed out since: refused — with no database read, and after a restart", %{conn: conn} do
      u = user("hp-out")
      conn = signed_in(conn, u)
      Process.sleep(2)
      :ok = Accounts.mark_logged_out(u.id)

      {res, qs} = queries(fn -> get(conn, "/api/me") end)
      assert json_response(res, 200)["user"] == nil
      assert qs == []

      :ets.delete_all_objects(:sign_outs)
      :ok = SignOuts.load()
      assert json_response(get(conn, "/api/me"), 200)["user"] == nil
    end

    test "deleted since: refused, after a restart too", %{conn: conn} do
      u = user("hp-del")
      session = signed_in(conn, u)
      Process.sleep(2)

      assert json_response(
               post(signed_in(build_conn(), u), "/api/account/delete", %{"confirm" => "DELETE"}),
               200
             )

      :ets.delete_all_objects(:sign_outs)
      :ok = SignOuts.load()
      assert json_response(get(session, "/api/me"), 200)["user"] == nil
    end

    test "older than 30 days: refused", %{conn: conn} do
      u = user("hp-old")
      old = System.system_time(:millisecond) - 31 * 86_400_000
      assert json_response(get(signed_in(conn, u, old), "/api/me"), 200)["user"] == nil
    end

    test "a session from before (no name in it) still works — the old way, one read", %{
      conn: conn
    } do
      u = user("hp-legacy")

      conn =
        init_test_session(conn, %{user_id: u.id, signed_in_at: System.system_time(:millisecond)})

      {res, qs} = queries(fn -> get(conn, "/api/me") end)
      assert json_response(res, 200)["user"]["name"] == "hp-legacy"
      assert length(qs) == 1
    end
  end

  describe "everyone /api/state mentions, in ONE query" do
    test "5 chats and 3 waiting riders: one lookup", %{conn: conn} do
      me = user("hp-me")
      Geo.driver_update(%{id: me.id, name: me.name, photo: nil}, @cell, nil)

      for i <- 1..5 do
        p = user("hp-c#{i}")
        {:ok, _} = Chat.send_message(%{id: p.id, name: p.name, photo: nil}, me.id, "hi #{i}")
      end

      for i <- 1..3 do
        r = user("hp-r#{i}")
        :ok = Requests.create(%{id: r.id, name: r.name, photo: nil}, me.id)
      end

      conn = signed_in(conn, me)
      {res, qs} = queries(fn -> get(conn, "/api/state") end)
      body = json_response(res, 200)
      assert length(body["conversations"]) == 5
      assert length(body["pending_requests"]) == 3
      assert Enum.all?(body["conversations"], &is_binary(&1["peer"]["name"]))
      assert length(qs) == 1, "one lookup for everyone, got: #{inspect(qs)}"
    end

    # not agreed to the Terms yet (in this session): the account is read once
    # more — it may have agreed on another device (AuthController) — only
    # until it has
    test "not yet agreed to the Terms: the account's own lookup", %{conn: conn} do
      me = user("hp-terms")

      conn =
        init_test_session(conn, %{
          user_id: me.id,
          signed_in_at: System.system_time(:millisecond),
          name: me.name
        })

      {res, qs} = queries(fn -> get(conn, "/api/state") end)
      assert json_response(res, 200)["terms_agreed"] == false
      # (nobody else mentioned: no other lookup)
      assert [q] = qs
      assert q =~ ~s(FROM "users") and q =~ "terms_version"
    end

    test "a shared block (chat, request) survives a reload, with its age", %{conn: conn} do
      driver = user("hp-blk-d")
      rider = user("hp-blk-r")
      Geo.driver_update(%{id: driver.id, name: driver.name, photo: nil}, @cell, nil)

      {:ok, _} =
        Chat.send_message(
          %{id: rider.id, name: rider.name, photo: nil},
          driver.id,
          "hi",
          "892a1072c63ffff"
        )

      :ok =
        Requests.create(
          %{id: rider.id, name: rider.name, photo: nil},
          driver.id,
          "892a1072c67ffff"
        )

      body = json_response(get(signed_in(conn, driver), "/api/state"), 200)

      assert [%{"peer_spot" => %{"spot" => "892a1072c63ffff", "age_ms" => a1}}] =
               body["conversations"]

      assert [%{"spot" => %{"spot" => "892a1072c67ffff", "age_ms" => a2}}] =
               body["pending_requests"]

      assert a1 >= 0 and a2 >= 0
    end

    test "the server's clock comes along, so 'how long ago' is right on a phone whose clock is off",
         %{conn: conn} do
      me = user("hp-now")
      before = System.system_time(:millisecond)
      body = json_response(get(signed_in(conn, me), "/api/state"), 200)
      assert is_integer(body["now"]) and body["now"] >= before
      assert body["now"] <= System.system_time(:millisecond)
    end

    test "the database can't answer: 503 (the app retries), never a half state", %{conn: conn} do
      me = user("hp-me2")
      p = user("hp-p2")
      {:ok, _} = Chat.send_message(%{id: p.id, name: p.name, photo: nil}, me.id, "hi")
      Repo.query!("ALTER TABLE users RENAME TO users_away")
      res = get(signed_in(conn, me), "/api/state")
      assert json_response(res, 503) == %{"error" => "busy"}
    end
  end

  describe "the names reveal asks for, in ONE query" do
    defp watching(key) do
      rider = TestClient.start(String.to_atom(key), user(key))
      assert {:ok, _} = TestClient.request(rider, "world", "sync", %{"geo" => [@cell]})
      rider
    end

    defp car(key) do
      u = user(key)
      Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, @cell, nil)
      u
    end

    test "10 names: one lookup", %{conn: _} do
      cars = for i <- 1..10, do: car("hp-car#{i}")
      rider = watching("hp-rider")
      ids = Enum.map(cars, & &1.id)

      {reply, qs} =
        queries(fn -> TestClient.request(rider, "world", "reveal", %{"ids" => ids}) end)

      assert {:ok, %{users: users, later: []}} = reply
      assert length(users) == 10
      assert Enum.count(qs, &(&1 =~ ~s(FROM "users"))) == 1
    end
  end
end
