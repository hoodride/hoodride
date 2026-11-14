defmodule HoodrideWeb.ServerTruthTest do
  @moduledoc "The server never swallows a client claim: sizes, ghosts, physics bounds."
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    Hoodride.TestHelpers.scrub_live_state()

    {:ok, user} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "st-u", name: "TruthU"})

    :ok = Hoodride.TestHelpers.give_car(user.id)

    {:ok, peer} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "st-p", name: "TruthP"})

    {:ok, socket} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, chan} = subscribe_and_join(socket, "user:#{user.id}", %{})
    %{user: user, peer: peer, socket: socket, chan: chan}
  end

  test "token auth: a signed token connects and owns its channel; garbage is refused",
       %{user: user} do
    token = Hoodride.TestHelpers.socket_token_for(user.id)

    {:ok, socket} = connect(HoodrideWeb.UserSocket, %{"token" => token})
    {:ok, _, _chan} = subscribe_and_join(socket, "user:#{user.id}", %{})

    assert :error = connect(HoodrideWeb.UserSocket, %{"token" => "garbage"})
  end

  test "driver_offline and hand_down work over the wire, not just at the engine",
       %{chan: chan, user: u} do
    push(chan, "driver_update", %{"spot" => "892a1072c63ffff", "lat" => 1.0, "lng" => 2.0})
    ref = push(chan, "cancel_request", %{})
    assert_reply ref, :ok
    assert Hoodride.Geo.driver_on_map?(u.id)

    push(chan, "driver_offline", %{})
    ref = push(chan, "cancel_request", %{})
    assert_reply ref, :ok
    refute Hoodride.Geo.driver_on_map?(u.id)

    push(chan, "hand_up", %{"spot" => "892a1072c63ffff"})
    ref = push(chan, "cancel_request", %{})
    assert_reply ref, :ok
    assert [{_, _, _}] = :ets.lookup(:geo_hands, u.id)

    push(chan, "hand_down", %{})
    ref = push(chan, "cancel_request", %{})
    assert_reply ref, :ok
    assert :ets.lookup(:geo_hands, u.id) == []
  end

  # the box warns at 500 (HoodChatList); the server is a looser backstop at
  # 2,000: phones and server can run different Unicode versions, and a
  # stacked conjunct like "क्ष्म्य" is 1 character now but 4 under older
  # rules — so a message the box allowed is never refused here
  test "oversized messages are refused; max-size passes", %{chan: chan, peer: p, socket: socket} do
    # the peer is a car on our screen, so the max-size message may go out
    Hoodride.Geo.driver_update(%{id: p.id, name: p.name, photo: nil}, "cellM", nil)
    {:ok, _, world} = subscribe_and_join(socket, "world", %{})
    ref = push(world, "sync", %{"geo" => ["cellM"]})
    assert_reply ref, :ok

    ref = push(chan, "send_msg", %{"to" => p.id, "text" => String.duplicate("x", 2001)})
    assert_reply ref, :error, %{reason: "too_long"}
    assert Hoodride.Chat.conversations_for(p.id) == []

    ref = push(chan, "send_msg", %{"to" => p.id, "text" => String.duplicate("x", 2000)})
    assert_reply ref, :ok
  end

  # (2026-10-29) the 500 counts what people see as characters — one of them
  # can carry thousands of stacked marks ("Zalgo"), so a 500-character
  # message could be megabytes. Two more limits: 20 KB (500 of the heaviest
  # real emoji, 35 bytes each, is 17.5 KB), and at most 30 marks
  # in a row (Unicode's Stream-Safe Text Format: 30 is "significantly beyond
  # what is required for any linguistic or technical usage")
  describe "messages in any language, but no stuffing" do
    setup %{socket: socket, peer: p} do
      Hoodride.Geo.driver_update(%{id: p.id, name: p.name, photo: nil}, "cellM", nil)
      {:ok, _, world} = subscribe_and_join(socket, "world", %{})
      ref = push(world, "sync", %{"geo" => ["cellM"]})
      assert_reply ref, :ok
      :ok
    end

    test "real languages and emoji pass, at full length", %{chan: chan, peer: p} do
      for text <- [
            "שלום, איפה אתה?",
            "مرحبا، أين أنت؟",
            "नमस्ते, आप कहाँ हैं?",
            "ཀྲཱྀཾ",
            String.duplicate("👨‍👩‍👧‍👦", 500),
            String.duplicate("🏴󠁧󠁢󠁥󠁮󠁧󠁿", 500),
            String.duplicate("👩🏻‍❤️‍💋‍👨🏼", 500),
            # (with spaces, as written: run together with no break, 250 of
            # these join into ONE 3,000-byte character by Unicode's rules —
            # past the one-character limit, and no real text: 2026-11-14)
            String.duplicate("க்ஷ் ", 200),
            "நீங்கள் எங்கே இருக்கிறீர்கள்?",
            String.duplicate("क्ष्म्य", 500)
          ] do
        ref = push(chan, "send_msg", %{"to" => p.id, "text" => text})
        assert_reply ref, :ok, _, 1000
      end
    end

    test "500 characters stuffed with marks past 20 KB: too long", %{chan: chan, peer: p} do
      # 500 letters, each carrying 25 marks (under the 30): 500 "characters", ~25 KB
      text = String.duplicate("a" <> String.duplicate("́", 25), 500)
      assert String.length(text) == 500
      assert byte_size(text) > 20_480
      ref = push(chan, "send_msg", %{"to" => p.id, "text" => text})
      assert_reply ref, :error, %{reason: "too_long"}
      assert Hoodride.Chat.conversations_for(p.id) == []
    end

    test "more than 30 marks stacked on one letter: refused; 30 pass", %{chan: chan, peer: p} do
      ref = push(chan, "send_msg", %{"to" => p.id, "text" => "hi a" <> String.duplicate("́", 31)})
      assert_reply ref, :error, %{reason: "stacked_marks"}
      assert Hoodride.Chat.conversations_for(p.id) == []

      ref = push(chan, "send_msg", %{"to" => p.id, "text" => "hi a" <> String.duplicate("́", 30)})
      assert_reply ref, :ok
    end

    # (crash review 2026-11-14) the 30-in-a-row rule was dodged by breaking
    # the row with characters that aren't marks but still join the same
    # letter (a zero-width joiner, variation selectors, tags): ~9,000 marks
    # on one letter, under 20 KB. Now one character can't be over 100 bytes
    # — the heaviest real emoji is 35, a flag 28
    test "marks split up by joiners on one letter: refused; the heaviest real emoji pass",
         %{chan: chan, peer: p} do
      for joiner <- ["\u200D", "\u200C", "\uFE0F", "\u{E0041}"] do
        text = "a" <> String.duplicate(String.duplicate("\u0301", 30) <> joiner, 300)
        assert byte_size(text) < Hoodride.Limits.message_bytes()
        ref = push(chan, "send_msg", %{"to" => p.id, "text" => text})
        assert_reply ref, :error, %{reason: "stacked_marks"}
      end

      for real <- [
            "\u{1F469}\u{1F3FB}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}\u{1F3FC}",
            "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
            "\u{1F468}\u{1F3FB}\u200D\u{1F469}\u{1F3FB}\u200D\u{1F467}\u{1F3FB}\u200D\u{1F466}\u{1F3FB}",
            "\u0915\u094D\u0937\u094D\u092E\u094D\u092F"
          ] do
        ref = push(chan, "send_msg", %{"to" => p.id, "text" => "hi " <> real})
        assert_reply ref, :ok
      end
    end
  end

  test "conversation history is capped at the last #{Hoodride.Limits.chat_history()} messages", %{
    user: u,
    peer: p
  } do
    me = %{id: u.id, name: u.name, photo: nil}
    cap = Hoodride.Limits.chat_history()

    for i <- 1..(cap + 5) do
      {:ok, _} = Hoodride.Chat.send_message(me, p.id, "msg #{i}")
    end

    [conv] = Hoodride.Chat.conversations_for(p.id)
    assert length(conv.messages) == cap
    # the oldest five fell off the back; the newest survives
    texts = Enum.map(conv.messages, & &1.text)
    refute "msg 5" in texts
    assert "msg 6" in texts
    assert List.last(texts) == "msg #{cap + 5}"
  end

  # a ghost gets the SAME refusal as any unreachable person: saying
  # "no such user" told anyone which ids are real
  test "messages to ghost users are refused and leave no trace", %{chan: chan} do
    ref = push(chan, "send_msg", %{"to" => 999_999, "text" => "hello void"})
    assert_reply ref, :error, %{reason: "unavailable"}
    assert Hoodride.Chat.all_conversations() == []
  end

  test "messages to yourself are refused and leave no trace", %{chan: chan, user: u} do
    ref = push(chan, "send_msg", %{"to" => u.id, "text" => "dear me"})
    assert_reply ref, :error, %{reason: "self"}
    assert Hoodride.Chat.all_conversations() == []
  end

  test "requests to ghost drivers are refused", %{chan: chan, user: u} do
    ref = push(chan, "request_ride", %{"to" => 999_999})
    assert_reply ref, :error, %{reason: "unavailable"}
    assert Hoodride.Requests.open_request_of(u.id) == nil
  end

  test "a browsing car is cells only: bad spots are refused, coordinates never kept", %{
    chan: chan
  } do
    cell = "882a1072c7fffff"

    for spot <- [123, nil, %{"x" => 1}, String.duplicate("x", 25), "cellT", cell] do
      ref = push(chan, "driver_update", %{"cell" => cell, "spot" => spot})
      assert_reply ref, :error, %{reason: "bad_request"}
    end

    assert Hoodride.Geo.cell_snapshot(cell).drivers == []

    # an older app's coordinates are simply ignored — even impossible ones
    ref =
      push(chan, "driver_update", %{"spot" => "892a1072c63ffff", "lat" => 9999, "lng" => -180.5})

    refute_reply ref, :error
    # sync barrier so the cast has been processed
    sync = push(chan, "cancel_request", %{})
    assert_reply sync, :ok
    assert [car] = Hoodride.Geo.cell_snapshot(cell).drivers
    assert car.spot == "892a1072c63ffff"
    # no coordinate kept: no field IS one (nor any decimal at all) — not a
    # text search, which a random user id containing "9999" failed
    # (gate, 2026-11-02)
    for row <- :ets.tab2list(:geo_drivers), field <- Tuple.to_list(row) do
      refute field in [9999, -180.5], "a coordinate kept: #{inspect(row)}"
      refute is_float(field), "a decimal kept: #{inspect(row)}"
    end
  end

  test "garbage mega-string cells are refused", %{chan: chan} do
    ref = push(chan, "hand_up", %{"cell" => String.duplicate("z", 500)})
    assert_reply ref, :error, %{reason: "bad_request"}
    assert :ets.tab2list(:geo_hands) == []
  end

  test "ride positions are relayed, NEVER stored — the coordinate exists nowhere server-side",
       %{user: u, peer: p, socket: socket} do
    {:ok, ride_id} = Hoodride.Rides.start_ride(u.id, p.id)
    {:ok, _, ride} = subscribe_and_join(socket, "ride:#{ride_id}", %{})

    # a recognizable coordinate, streamed through the ride channel
    needle = 40.71239517
    push(ride, "pos", %{"lat" => needle, "lng" => -74.00417731})
    assert_broadcast "peer_pos", %{lat: ^needle}

    # hunt for it in every piece of server state that exists
    tables = [
      :geo_drivers,
      :geo_hands,
      :geo_presence,
      :chat_conversations,
      :chat_messages,
      :ride_requests,
      :rides_by_user
    ]

    all_ets = Enum.flat_map(tables, &:ets.tab2list/1)
    {:ok, ride_state} = Hoodride.Rides.get(ride_id)

    haystack = inspect({all_ets, ride_state}, limit: :infinity)

    refute haystack =~ "40.71239517",
           "a relayed ride position leaked into server state: #{haystack}"
  end

  test "ride position and pin are bounds-checked too", %{user: u, peer: p, socket: socket} do
    {:ok, ride_id} = Hoodride.Rides.start_ride(u.id, p.id)
    {:ok, _, ride} = subscribe_and_join(socket, "ride:#{ride_id}", %{})

    ref = push(ride, "pos", %{"lat" => 123.0, "lng" => 0.0})
    assert_reply ref, :error, %{reason: "bad_request"}

    ref = push(ride, "set_pin", %{"lat" => 0.0, "lng" => 999.0})
    assert_reply ref, :error, %{reason: "bad_request"}
    assert {:ok, %{pin: nil}} = Hoodride.Rides.get(ride_id)
  end
end
