defmodule HoodrideWeb.DeleteAccountTest do
  @moduledoc """
  Delete account (privacy: the right to delete; Meta asks for a deletion
  route too). From the drawer, after a confirmation step; refused during a
  ride or while your own ride request waits (like sign-out). In order:

    1. the denylist (Hoodride.SignOuts) — every token and session dies first;
    2. live state cleared — off the map (car and ✋), incoming requests
       declined (each rider told), chats closed (the partner told),
       presence and the session stamp forgotten;
    3. the database row deleted;
    4. every device disconnected, the session ended.

  Signing in again with the same Google account starts a NEW account.
  """
  use HoodrideWeb.ConnCase, async: false

  require Phoenix.ChannelTest

  alias Hoodride.{Accounts, Chat, Geo, Requests, Rides, SessionStamp, SignOuts}
  alias HoodrideWeb.Auth

  @cell "882a1072c7fffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp me_map(u), do: %{id: u.id, name: u.name, photo: u.photo}

  defp signed_in(conn, u),
    do: init_test_session(conn, %{user_id: u.id, signed_in_at: System.system_time(:millisecond)})

  defp delete_account(conn, body \\ %{"confirm" => "DELETE"}),
    do: post(conn, "/api/account/delete", body)

  describe "deleting" do
    test "the account is gone; its old session and token are refused", %{conn: conn} do
      u = user("del-a")
      token = Auth.socket_token(u)
      before = System.system_time(:millisecond)
      Process.sleep(2)
      conn = delete_account(signed_in(conn, u))
      assert json_response(conn, 200) == %{"ok" => true}

      assert Accounts.get_user(u.id) == nil
      assert json_response(get(signed_in(build_conn(), u), "/api/me"), 200)["user"] == nil

      assert Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
               connect_info: %{auth_token: token}
             ) == :error

      refute SignOuts.allowed?(u.id, before), "anything issued before the deletion"
    end

    test "the session cookie is ended", %{conn: conn} do
      u = user("del-sess")
      conn = delete_account(signed_in(conn, u))
      # dropped when the response goes out: the cookie is cleared
      assert conn.private[:plug_session_info] == :drop
    end

    test "off the map: the car and the ✋ are taken down", %{conn: conn} do
      u = user("del-map")
      Geo.driver_update(me_map(u), @cell, nil, [])
      assert Geo.driver_on_map?(u.id)
      delete_account(signed_in(conn, u))
      refute Geo.driver_on_map?(u.id)
      assert Geo.hand_of(u.id) == nil
    end

    test "incoming ride requests are declined, and each rider is told", %{conn: conn} do
      driver = user("del-drv")
      rider = user("del-rdr")
      Geo.driver_update(me_map(driver), @cell, nil, [])
      assert :ok = Requests.create(me_map(rider), driver.id)
      HoodrideWeb.Endpoint.subscribe("user:#{rider.id}")

      delete_account(signed_in(conn, driver))
      assert_receive %Phoenix.Socket.Broadcast{event: "request_declined", payload: %{by_id: by}}
      assert by == driver.id
      assert Requests.open_request_of(rider.id) == nil
    end

    test "chats are closed, and the partner is told", %{conn: conn} do
      u = user("del-chat")
      peer = user("del-peer")
      {:ok, _} = Chat.send_message(me_map(u), peer.id, "hi")
      HoodrideWeb.Endpoint.subscribe("user:#{peer.id}")

      delete_account(signed_in(conn, u))
      assert_receive %Phoenix.Socket.Broadcast{event: "chat_closed", payload: %{peer_id: pid}}
      assert pid == u.id
      assert Chat.conversations_for(peer.id) == []
    end

    test "presence and the session stamp are forgotten", %{conn: conn} do
      u = user("del-pres")
      Geo.user_connected(u.id)
      SessionStamp.saw(u.id, SessionStamp.issue())
      delete_account(signed_in(conn, u))
      assert Geo.presence_of(u.id) == {:offline, 0}
      assert SessionStamp.highest(u.id) == nil
    end

    test "every device is disconnected", %{conn: conn} do
      u = user("del-sock")
      HoodrideWeb.Endpoint.subscribe("user_socket:#{u.id}")
      delete_account(signed_in(conn, u))
      assert_receive %Phoenix.Socket.Broadcast{event: "disconnect"}
    end

    test "signing in again with the same Google account starts a NEW account", %{conn: conn} do
      u = user("del-again")
      delete_account(signed_in(conn, u))
      again = user("del-again")
      refute again.id == u.id
    end
  end

  describe "refused" do
    test "during a ride — end it first; nothing is deleted", %{conn: conn} do
      driver = user("del-ride-d")
      rider = user("del-ride-r")
      Geo.driver_update(me_map(driver), @cell, nil, [])
      :ok = Requests.create(me_map(rider), driver.id)
      assert {:ok, _} = Requests.accept(me_map(driver), rider.id)
      assert Rides.ride_id_of_user(rider.id)

      conn = delete_account(signed_in(conn, rider))
      assert json_response(conn, 409) == %{"error" => "in_ride"}
      assert Accounts.get_user(rider.id)
    end

    test "while your own ride request is waiting — cancel it first", %{conn: conn} do
      driver = user("del-req-d")
      rider = user("del-req-r")
      Geo.driver_update(me_map(driver), @cell, nil, [])
      :ok = Requests.create(me_map(rider), driver.id)

      conn = delete_account(signed_in(conn, rider))
      assert json_response(conn, 409) == %{"error" => "request_waiting"}
      assert Accounts.get_user(rider.id)
    end

    test "without the confirmation", %{conn: conn} do
      u = user("del-noconf")

      assert json_response(delete_account(signed_in(conn, u), %{}), 400) == %{
               "error" => "confirm"
             }

      assert Accounts.get_user(u.id)
    end

    # typed, not just tapped (owner, 2026-11-04): the word the person typed,
    # any case; a bare `true` (what an old copy of the app sent without the
    # box) or anything else is refused, and the account stays
    test "the typed word, any case, spaces ignored", %{conn: conn} do
      for {word, n} <- Enum.with_index(["DELETE", "delete", " Delete "]) do
        u = user("del-word-#{n}")

        assert json_response(delete_account(signed_in(conn, u), %{"confirm" => word}), 200) == %{
                 "ok" => true
               }

        refute Accounts.get_user(u.id)
      end
    end

    # in the reader's language too (Cloudscape: the confirmation word is
    # localized; owner, 2026-11-04) — and whatever language the page was in:
    # the screen asking for one word while the server checks another is the
    # AWS console's French bug
    test "the word in the reader's language: ELIMINAR, any case", %{conn: conn} do
      for {word, n} <- Enum.with_index(["ELIMINAR", "eliminar", " Eliminar "]) do
        u = user("del-es-#{n}")

        assert json_response(delete_account(signed_in(conn, u), %{"confirm" => word}), 200) == %{
                 "ok" => true
               }

        refute Accounts.get_user(u.id)
      end
    end

    test "every language's screen asks for a word the server accepts" do
      words = Hoodride.I18n.delete_words()
      assert "delete" in words and "eliminar" in words

      for lang <- Hoodride.I18n.known(), lang != "en" do
        source = File.read!(Path.join("priv/static", Hoodride.I18n.script(lang)))
        [_, json] = Regex.run(~r/^HoodI18n\.load\((.*)\);$/m, source)

        asked =
          Jason.decode!(json)["messages"]["the word typed to delete the account\u0004DELETE"]

        assert is_binary(asked), "#{lang}: no word to type"
        assert Hoodride.I18n.typed_word(asked) in words, "#{lang} asks for #{asked}"
      end

      # the sentences around it carry the word in, never a word of their own
      pot = File.read!("priv/gettext/default.pot")
      assert pot =~ ~s(msgid "Type {word} to confirm")
      refute pot =~ "Type DELETE"
    end

    test "not the word: refused, nothing deleted", %{conn: conn} do
      for {bad, n} <-
            Enum.with_index([
              true,
              "true",
              "delet",
              "DELETE IT",
              "",
              nil,
              1,
              %{"a" => 1},
              "BORRAR",
              "eliminar ya"
            ]) do
        u = user("del-bad-#{n}")

        assert json_response(delete_account(signed_in(conn, u), %{"confirm" => bad}), 400) == %{
                 "error" => "confirm"
               },
               inspect(bad)

        assert Accounts.get_user(u.id)
      end
    end

    test "signed out", %{conn: conn} do
      assert json_response(delete_account(conn), 401) == %{"error" => "unauthenticated"}
    end
  end
end
