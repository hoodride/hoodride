defmodule HoodrideWeb.LightReloadTest do
  @moduledoc """
  Light reload (owner, 2026-11-08) — the server half. A reload used to bring
  every chat's every message. Now the app can ask for the chat LIST
  (`/api/state?chats=list`): each chat as a summary — its last message's
  preview and the partner's message ids for unread, no texts — plus, by
  `open_peer`, the one chat on screen in full (a reconnect keeps its
  place). A chat's messages come when it's opened: `GET /api/chat?peer=`,
  your own chats only, with its own budget. Without `chats=list` the
  answer is exactly as before (older app copies, mid-deploy).
  """
  use HoodrideWeb.ConnCase, async: false

  @moduletag :capture_log

  alias Hoodride.{Accounts, Chat}

  setup do
    # (budgets and chats are per account, and ids repeat between tests)
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    :ok = Accounts.agree_to_terms(u.id)
    Accounts.get_user(u.id)
  end

  defp who(u), do: %{id: u.id, name: u.name, photo: nil}

  # signed in, the Terms agreed (in the session, as after "I agree")
  defp signed_in(u) do
    session =
      Hoodride.TestHelpers.session_for(u.id) |> Map.put("terms_version", Hoodride.Terms.version())

    init_test_session(build_conn(), session)
  end

  defp say(from, to, text), do: {:ok, _} = Chat.send_message(who(from), to.id, text)

  defp list(u, extra \\ ""),
    do: json_response(get(signed_in(u), "/api/state?chats=list" <> extra), 200)

  defp chat(u, peer), do: get(signed_in(u), "/api/chat?peer=" <> peer)

  defp by_peer(body, u), do: Enum.find(body["conversations"], &(&1["peer"]["id"] == u.id))

  # how many database queries `fun` makes (Ecto's telemetry)
  defp queries(fun) do
    me = self()
    id = {__MODULE__, make_ref()}

    :telemetry.attach(
      id,
      [:hoodride, :repo, :query],
      fn _, _, meta, _ -> send(me, {:q, meta.query}) end,
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
      {:q, q} -> collect([q | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  describe "the chat list (chats=list)" do
    test "each chat as a summary: no texts, the last message's preview, the partner's ids" do
      me = user("lr-me")
      ann = user("lr-ann")
      say(ann, me, "hi there")
      say(me, ann, "on my way")
      say(ann, me, "great, see you")

      c = by_peer(list(me), ann)
      refute Map.has_key?(c, "messages")
      assert c["peer"]["name"] == "lr-ann"
      assert is_integer(c["last_activity"])
      assert %{"id" => _, "ts" => _, "mine" => false, "preview" => "great, see you"} = c["last"]
      # the partner's messages only: what unread counts
      assert length(c["theirs"]) == 2
      assert Enum.all?(c["theirs"], &(Map.keys(&1) |> Enum.sort() == ["id", "ts"]))
      # no message's text anywhere but the last one's preview
      json = Jason.encode!(list(me))
      refute json =~ "hi there"
      refute json =~ "on my way"
    end

    test "my own last message: mine; a chat with no message (a ride's): last nil, theirs empty" do
      me = user("lr-me2")
      bo = user("lr-bo")
      cy = user("lr-cy")
      say(me, bo, "me last")
      :ok = Chat.open(me.id, cy.id)

      body = list(me)
      assert by_peer(body, bo)["last"]["mine"] == true
      assert by_peer(body, cy)["last"] == nil
      assert by_peer(body, cy)["theirs"] == []
    end

    test "the preview: whole characters, at most 100 and 400 bytes — as many as fit" do
      me = user("lr-me3")
      dee = user("lr-dee")

      for text <- [
            String.duplicate("a", 150),
            # a family emoji is ONE character of 25 bytes: never cut inside it
            String.duplicate("👨‍👩‍👧‍👦", 30),
            # Hindi: 100 characters would be over 400 bytes — the bytes cut first
            String.duplicate("नमस्ते ", 30),
            "line one
line two	tab"
          ] do
        say(dee, me, text)
        p = by_peer(list(me), dee)["last"]["preview"]
        assert String.valid?(p)
        assert String.starts_with?(text, p), inspect(p)
        assert String.length(p) <= 100 and byte_size(p) <= 400, inspect(p)
        # as many as fit: one more whole character would break a limit
        rest = String.replace_prefix(text, p, "")

        case String.next_grapheme(rest) do
          nil -> :ok
          {g, _} -> assert String.length(p) == 100 or byte_size(p <> g) > 400, inspect({p, g})
        end
      end

      # (the emoji: 16 of them is exactly 400 bytes)
      say(dee, me, String.duplicate("👨‍👩‍👧‍👦", 30))
      assert by_peer(list(me), dee)["last"]["preview"] == String.duplicate("👨‍👩‍👧‍👦", 16)
    end

    test "the preview's own rule: a first character over 400 bytes gives an empty preview" do
      # (stacked marks the app itself refuses — so straight to the rule)
      huge = "e" <> String.duplicate("́", 300)
      assert byte_size(huge) > 400 and String.length(huge) == 1
      assert Chat.preview(huge) == ""
      assert Chat.preview("ok" <> huge) == "ok"
    end

    test "one more than kept (a send in progress): the newest kept, in order — the same set /api/chat gives" do
      me = user("lr-me4")
      eve = user("lr-eve")
      cap = Hoodride.Limits.chat_history()
      for i <- 1..cap, do: say(eve, me, "m#{i}")
      # one more, straight in (a send between its insert and its trim)
      key = Chat.pair_key(me.id, eve.id)

      :ets.insert(
        :chat_messages,
        {key, System.unique_integer([:positive, :monotonic]), eve.id, "m#{cap + 1}",
         System.system_time(:second)}
      )

      c = by_peer(list(me), eve)
      assert length(c["theirs"]) == cap
      assert c["last"]["preview"] == "m#{cap + 1}"
      ids = Enum.map(c["theirs"], & &1["id"])
      assert ids == Enum.sort(ids)

      msgs = json_response(chat(me, Integer.to_string(eve.id)), 200)["messages"]
      assert Enum.map(msgs, & &1["id"]) == ids
      assert hd(msgs)["text"] == "m2"
    end

    test "open_peer: that one chat comes in full (as before); others stay summaries" do
      me = user("lr-me5")
      fay = user("lr-fay")
      gus = user("lr-gus")
      say(fay, me, "from fay")
      say(gus, me, "from gus")

      body = list(me, "&open_peer=#{fay.id}")
      assert [%{"text" => "from fay"}] = by_peer(body, fay)["messages"]
      refute Map.has_key?(by_peer(body, gus), "messages")
    end

    test "open_peer that isn't one of my chats, or not a plain id: nothing extra" do
      me = user("lr-me6")
      hal = user("lr-hal")
      ivy = user("lr-ivy")
      say(hal, me, "hello")

      for extra <- [
            "&open_peer=#{ivy.id}",
            "&open_peer=#{me.id}",
            "&open_peer=0#{hal.id}",
            "&open_peer=#{hal.id}abc",
            "&open_peer[]=#{hal.id}",
            "&open_peer="
          ] do
        body = list(me, extra)
        assert Enum.all?(body["conversations"], &(not Map.has_key?(&1, "messages"))), extra
      end
    end

    test "without chats=list, or a chats value that isn't exactly \"list\": the full answer as before" do
      me = user("lr-me7")
      jo = user("lr-jo")
      say(jo, me, "full please")

      for path <- [
            "/api/state",
            "/api/state?chats=lists",
            "/api/state?chats[]=list",
            "/api/state?chats[a]=list"
          ] do
        c = by_peer(json_response(get(signed_in(me), path), 200), jo)
        assert [%{"text" => "full please"}] = c["messages"], path
        refute Map.has_key?(c, "theirs")
      end
    end

    test "a partner whose account is gone: left out of the list (as before)" do
      me = user("lr-me8")
      kit = user("lr-kit")
      say(kit, me, "bye")
      Hoodride.Repo.query!("DELETE FROM users WHERE id = ?", [kit.id])

      assert list(me)["conversations"] == []
    end

    test "one database query for everyone the list mentions (as before)" do
      me = user("lr-me9")
      for i <- 1..4, do: say(user("lr-q#{i}"), me, "hi #{i}")

      conn = signed_in(me)
      {res, qs} = queries(fn -> get(conn, "/api/state?chats=list") end)
      assert length(json_response(res, 200)["conversations"]) == 4
      assert length(qs) == 1, inspect(qs)
    end

    test "never stored by a browser or proxy: no-store, signed out too" do
      me = user("lr-me10")

      assert get_resp_header(get(signed_in(me), "/api/state?chats=list"), "cache-control") == [
               "no-store"
             ]

      assert get_resp_header(get(signed_in(me), "/api/state"), "cache-control") == ["no-store"]
      assert get_resp_header(get(build_conn(), "/api/state"), "cache-control") == ["no-store"]
    end
  end

  describe "one chat's messages (GET /api/chat)" do
    test "my chat: its messages, oldest first, today's shape" do
      me = user("lr-c1")
      lu = user("lr-lu")
      say(lu, me, "one")
      say(me, lu, "two")

      res = chat(me, Integer.to_string(lu.id))
      assert get_resp_header(res, "cache-control") == ["no-store"]
      msgs = json_response(res, 200)["messages"]
      assert [%{"text" => "one", "from" => f1}, %{"text" => "two", "from" => f2}] = msgs
      assert {f1, f2} == {lu.id, me.id}
      assert Enum.all?(msgs, &(Map.keys(&1) |> Enum.sort() == ["from", "id", "text", "ts"]))
    end

    test "a ride's chat with no message yet: an empty list" do
      me = user("lr-c2")
      mo = user("lr-mo")
      :ok = Chat.open(me.id, mo.id)
      assert json_response(chat(me, Integer.to_string(mo.id)), 200) == %{"messages" => []}
    end

    test "not mine, my own id, made up, missing or odd: the same 404, nothing told" do
      me = user("lr-c3")
      ned = user("lr-ned")
      ola = user("lr-ola")
      # (Ned and Ola talk; I'm not in it)
      say(ned, ola, "private")
      say(ned, me, "hi")

      for peer <- [
            Integer.to_string(ola.id),
            Integer.to_string(me.id),
            "999999",
            "0#{ned.id}",
            "#{ned.id}x",
            ""
          ] do
        res = chat(me, peer)
        assert json_response(res, 404) == %{"error" => "none"}, peer
      end

      assert json_response(get(signed_in(me), "/api/chat"), 404) == %{"error" => "none"}

      assert json_response(get(signed_in(me), "/api/chat?peer[]=#{ned.id}"), 404) == %{
               "error" => "none"
             }
    end

    test "an index row left behind by a deleted chat: 404 (the chat itself is checked)" do
      me = user("lr-c4")
      pam = user("lr-pam")
      say(pam, me, "soon gone")
      key = Chat.pair_key(me.id, pam.id)
      # (a delete removes the index first; a race can leave one row)
      :ets.delete(:chat_conversations, key)
      :ets.delete(:chat_messages, key)

      assert json_response(chat(me, Integer.to_string(pam.id)), 404) == %{"error" => "none"}
    end

    test "a partner whose account is gone: still loads (never listed — harmless)" do
      me = user("lr-c5")
      quin = user("lr-quin")
      say(quin, me, "still here")
      Hoodride.Repo.query!("DELETE FROM users WHERE id = ?", [quin.id])

      assert [%{"text" => "still here"}] =
               json_response(chat(me, Integer.to_string(quin.id)), 200)["messages"]
    end

    test "signed out: 401; the Terms not agreed: 403 terms (as the connection pass)" do
      me = user("lr-c6")

      assert json_response(get(build_conn(), "/api/chat?peer=1"), 401) == %{
               "error" => "unauthenticated"
             }

      fresh = Hoodride.TestHelpers.session_for(me.id) |> Map.put("terms_version", "1999-01-01")
      res = init_test_session(build_conn(), fresh) |> get("/api/chat?peer=1")
      assert json_response(res, 403) == %{"error" => "terms"}
    end

    test "the tab showing another account: refused (one account per tab)" do
      me = user("lr-c7")
      rex = user("lr-rex")

      res =
        signed_in(me)
        |> put_req_header("x-hood-user", Integer.to_string(rex.id))
        |> get("/api/chat?peer=1")

      assert res.status == 409
      assert get_resp_header(res, "x-hood-other-account") == ["1"]
    end

    test "no database query at all" do
      me = user("lr-c8")
      sue = user("lr-sue")
      say(sue, me, "fast")
      conn = signed_in(me)
      {res, qs} = queries(fn -> get(conn, "/api/chat?peer=#{sue.id}") end)
      assert json_response(res, 200)
      assert qs == [], inspect(qs)
    end

    test "its own budget: 61 at once, the 62nd waits — and /api/state still answers" do
      me = user("lr-c9")
      tom = user("lr-tom")
      say(tom, me, "hi")
      peer = Integer.to_string(tom.id)

      for i <- 1..61, do: assert(chat(me, peer).status == 200, "call #{i}")
      assert json_response(chat(me, peer), 429)
      assert json_response(get(signed_in(me), "/api/state?chats=list"), 200)
    end
  end
end
