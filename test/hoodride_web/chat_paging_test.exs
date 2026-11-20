defmodule HoodrideWeb.ChatPagingTest do
  @moduledoc """
  The chat list in pages (owner, 2026-11-14). Nothing capped how many chats
  OTHER people start with you, and the light reload (`/api/state?chats=
  list`) brought every one on every app open and reconnect. Now:

    * the first page: the @page most recent chats (last activity, newest
      first), and `more` — where the next page starts, or nil;
    * `GET /api/chats?before=<more>`: the next page, the same shape. The
      cursor is "older than this chat", not "page 2": chats moving to the
      top meanwhile cause no duplicates or gaps;
    * the chat on screen (`open_peer`) always comes, in full, older or not;
    * "read up to" kept on the server too (in memory, with the chat: the
      same [time, id] bookmark the phone keeps — HoodReadStore), sent by
      the app as you read (`read`); each chat in a page carries yours
      (`read`), and `unread_more` counts their messages past it in the
      chats NOT yet loaded — so the 💬 badge is right without them.
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest,
    only: [subscribe_and_join: 3, assert_reply: 2, assert_reply: 3]

  @moduletag :capture_log

  alias Hoodride.{Accounts, Chat}

  @page Hoodride.Limits.chat_page()

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Accounts.agree_to_terms(u.id)
    Accounts.get_user(u.id)
  end

  defp who(u), do: %{id: u.id, name: u.name, photo: nil}

  defp signed_in(u) do
    session =
      Hoodride.TestHelpers.session_for(u.id) |> Map.put("terms_version", Hoodride.Terms.version())

    init_test_session(build_conn(), session)
  end

  defp say(from, to, text), do: {:ok, _} = Chat.send_message(who(from), to.id, text)

  # this chat's last activity, `s` seconds after a fixed start (ties apart)
  defp at(a, b, s),
    do:
      true =
        :ets.update_element(:chat_conversations, Chat.pair_key(a.id, b.id), {2, 1_000_000 + s})

  defp list(u, extra \\ ""),
    do: json_response(get(signed_in(u), "/api/state?chats=list" <> extra), 200)

  defp older(u, cursor),
    do: json_response(get(signed_in(u), "/api/chats?before=" <> URI.encode_www_form(cursor)), 200)

  defp peers(body), do: Enum.map(body["conversations"], & &1["peer"]["id"])

  # `n` people each message me once; the first the quietest
  defp crowd(me, n, key) do
    for i <- 1..n do
      p = user("#{key}-#{i}")
      say(p, me, "hi #{i}")
      at(me, p, i)
      p
    end
  end

  describe "pages" do
    test "the first page: the most recent chats, newest first, and where the next starts" do
      me = user("pg-me")
      crowd = crowd(me, @page + 5, "pg")

      body = list(me)
      assert peers(body) == crowd |> Enum.reverse() |> Enum.take(@page) |> Enum.map(& &1.id)
      assert is_binary(body["more"])
    end

    test "the next page from the cursor, then no more; nothing twice, nothing missed" do
      me = user("pg2-me")
      crowd = crowd(me, @page + 5, "pg2")

      first = list(me)
      second = older(me, first["more"])
      assert second["more"] == nil
      assert peers(first) ++ peers(second) == crowd |> Enum.reverse() |> Enum.map(& &1.id)
      # summaries, as the first page's
      assert Enum.all?(
               second["conversations"],
               &(Map.has_key?(&1, "last") and not Map.has_key?(&1, "messages"))
             )
    end

    test "a chat moving to the top meanwhile: no duplicate, no gap" do
      me = user("pg3-me")
      crowd = crowd(me, @page + 5, "pg3")

      first = list(me)
      # the quietest one writes again: now the newest — already seen on
      # page one? no: it moves to the top, which the next page never shows
      quiet = hd(crowd)
      say(quiet, me, "again")
      at(me, quiet, 10_000)

      second = older(me, first["more"])
      seen = peers(first) ++ peers(second)
      assert length(seen) == length(Enum.uniq(seen))
      # every other chat is in one page or the other
      assert MapSet.subset?(MapSet.new(Enum.map(tl(crowd), & &1.id)), MapSet.new(seen))
    end

    test "a few chats: one page, no more" do
      me = user("pg4-me")
      crowd(me, 3, "pg4")
      body = list(me)
      assert length(body["conversations"]) == 3
      assert body["more"] == nil
      assert body["unread_more"] == 0
    end

    test "the chat on screen comes in full, however old" do
      me = user("pg5-me")
      [oldest | _] = crowd(me, @page + 5, "pg5")

      body = list(me, "&open_peer=#{oldest.id}")
      c = Enum.find(body["conversations"], &(&1["peer"]["id"] == oldest.id))
      assert [%{"text" => "hi 1"}] = c["messages"]
    end

    # (review of the older chats, 2026-11-20) the chat on screen comes in
    # full — and its unread was counted AGAIN among the older chats' (the
    # app's 💬 count kept them after it was read: a phantom)
    test "the chat on screen in full: not counted again among the older chats' unread" do
      me = user("pg5b-me")
      [oldest | _] = crowd(me, @page + 5, "pg5b")

      plain = list(me)
      assert plain["unread_rest"][Integer.to_string(oldest.id)] == 1

      body = list(me, "&open_peer=#{oldest.id}")
      refute Map.has_key?(body["unread_rest"], Integer.to_string(oldest.id))
      assert body["unread_more"] == plain["unread_more"] - 1
    end

    # (review of the older chats, 2026-11-20) a chat's messages fetched when
    # it's opened came without the server's "read up to": a phone with no
    # mark of its own then counted every kept message as unread
    test "a chat's messages come with the server's 'read up to'" do
      me = user("pg7-me")
      [peer | _] = crowd(me, 1, "pg7")
      body = json_response(get(signed_in(me), "/api/chat?peer=#{peer.id}"), 200)
      assert body["read"] == nil
      [%{"ts" => ts, "id" => id}] = body["messages"]
      :ok = Hoodride.Chat.mark_read(me.id, peer.id, ts, id)
      body = json_response(get(signed_in(me), "/api/chat?peer=#{peer.id}"), 200)
      assert body["read"] == [ts, id]
    end

    test "a cursor that isn't one: 400" do
      me = user("pg6-me")

      for bad <- ["", "x", "1.2.3", "-1.5", "99999999999999999999999.1"] do
        conn = get(signed_in(me), "/api/chats?before=" <> URI.encode_www_form(bad))
        assert conn.status == 400, "#{inspect(bad)}: #{conn.status}"
      end

      assert get(signed_in(me), "/api/chats").status == 400
    end

    test "signed out: 401" do
      assert get(build_conn(), "/api/chats?before=1.1").status == 401
    end
  end

  describe "read up to (on the server)" do
    # the app's "read" event (Phoenix.ChannelTest.push — Plug.Conn has one too)
    defp read(chan, payload), do: Phoenix.ChannelTest.push(chan, "read", payload)

    defp join_me(me) do
      {:ok, socket} =
        Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
          connect_info: %{session: Hoodride.TestHelpers.session_for(me.id)}
        )

      {:ok, _, chan} = subscribe_and_join(socket, "user:#{me.id}", %{})
      chan
    end

    defp their_messages(me, peer),
      do:
        Chat.summary(Enum.find(Chat.conversations_for(me.id), &(&1.peer_id == peer.id)), me.id).theirs

    test "kept as the app reads; each chat in a page carries it" do
      me = user("rd-me")
      ann = user("rd-ann")
      say(ann, me, "one")
      say(ann, me, "two")
      [_, second] = their_messages(me, ann)

      chan = join_me(me)
      ref = read(chan, %{"peer" => ann.id, "ts" => second.ts, "id" => second.id})
      assert_reply ref, :ok

      c = list(me)["conversations"] |> hd()
      assert c["read"] == [second.ts, second.id]
    end

    # a phone with no bookmarks of its own (a new one, cleared storage): if
    # the account has read anything anywhere, the server's are the record —
    # not "everything there is read" (the first-run rule, HoodReadStore)
    test "read_known: whether the account has any \"read up to\" at all", %{} do
      me = user("rd6-me")
      ann = user("rd6-ann")
      crowd(me, @page + 1, "rd6")
      say(ann, me, "hi")
      assert list(me)["read_known"] == false

      # (a chat past the first page counts too)
      [quietest | _] = Enum.sort_by(Chat.conversations_for(me.id), & &1.last_activity)
      [m | _] = Chat.summary(quietest, me.id).theirs
      :ok = Chat.mark_read(me.id, quietest.peer_id, m.ts, m.id)
      assert list(me)["read_known"] == true
    end

    test "never moves back" do
      me = user("rd2-me")
      ann = user("rd2-ann")
      say(ann, me, "one")
      say(ann, me, "two")
      [first, second] = their_messages(me, ann)

      chan = join_me(me)

      assert_reply read(chan, %{"peer" => ann.id, "ts" => second.ts, "id" => second.id}),
                   :ok

      assert_reply read(chan, %{"peer" => ann.id, "ts" => first.ts, "id" => first.id}),
                   :ok

      assert hd(list(me)["conversations"])["read"] == [second.ts, second.id]
    end

    test "only to one of THEIR messages in that chat: anything else refused, nothing kept" do
      me = user("rd3-me")
      ann = user("rd3-ann")
      bob = user("rd3-bob")
      say(ann, me, "from ann")
      say(me, ann, "mine")
      say(bob, me, "from bob")
      [ann_msg] = their_messages(me, ann)
      [bob_msg] = their_messages(me, bob)

      mine =
        Chat.summary(Enum.find(Chat.conversations_for(me.id), &(&1.peer_id == ann.id)), me.id).last

      chan = join_me(me)

      for {peer, ts, id} <- [
            # another chat's message
            {ann.id, bob_msg.ts, bob_msg.id},
            # my own message
            {ann.id, mine.ts, mine.id},
            # made up
            {ann.id, ann_msg.ts + 100, ann_msg.id + 1},
            # nobody I chat with
            {999_999_999, ann_msg.ts, ann_msg.id}
          ] do
        ref = read(chan, %{"peer" => peer, "ts" => ts, "id" => id})
        assert_reply ref, :error, %{reason: _}
      end

      for bad <- [%{}, %{"peer" => "x"}, %{"peer" => ann.id, "ts" => "1", "id" => 1}] do
        assert_reply read(chan, bad), :error, %{reason: _}
      end

      assert Enum.all?(list(me)["conversations"], &(&1["read"] == nil))
    end

    test "gone with the chat" do
      me = user("rd4-me")
      ann = user("rd4-ann")
      say(ann, me, "hi")
      [m] = their_messages(me, ann)
      chan = join_me(me)
      assert_reply read(chan, %{"peer" => ann.id, "ts" => m.ts, "id" => m.id}), :ok
      assert :ets.info(:chat_reads, :size) == 1

      :ok = Chat.end_chat(me.id, ann.id)
      assert :ets.info(:chat_reads, :size) == 0
    end

    test "a stray (a read racing the chat's end) is cleaned up by the sweeper's repair" do
      me = user("rd5-me")
      ann = user("rd5-ann")
      :ets.insert(:chat_reads, {{Chat.pair_key(me.id, ann.id), me.id}, 1, 1})
      Chat.heal_index()
      assert :ets.info(:chat_reads, :size) == 0
    end
  end

  describe "unread in the chats not loaded yet" do
    test "their messages past your bookmark, in every chat after the page" do
      me = user("un-me")
      crowd = crowd(me, @page + 3, "un")
      # the 3 quietest are past the first page: 1 message each (crowd), and
      # the quietest says two more
      [quietest, second, _third | _] = crowd
      say(quietest, me, "a")
      say(quietest, me, "b")
      at(me, quietest, 1)

      body = list(me)
      refute quietest.id in peers(body)
      assert body["unread_more"] == 5
      # per chat too (owner, 2026-11-14): a chat not loaded that gets a new
      # message takes its own over — read, they go with it
      assert body["unread_rest"] == %{
               to_string(quietest.id) => 3,
               to_string(second.id) => 1,
               to_string(Enum.at(crowd, 2).id) => 1
             }

      # read the second-quietest's: 4 left
      [m] =
        Chat.summary(Enum.find(Chat.conversations_for(me.id), &(&1.peer_id == second.id)), me.id).theirs

      true = Chat.mark_read(me.id, second.id, m.ts, m.id) == :ok
      assert list(me)["unread_more"] == 4
      # (only the chats with unread)
      refute Map.has_key?(list(me)["unread_rest"], to_string(second.id))

      # and on the next page, counted after IT: nothing left beyond
      assert older(me, body["more"])["unread_more"] == 0
    end

    test "your own messages never count" do
      me = user("un2-me")
      crowd = crowd(me, @page + 1, "un2")
      say(me, hd(crowd), "my reply")
      at(me, hd(crowd), 0)
      assert list(me)["unread_more"] == 1
    end
  end
end
