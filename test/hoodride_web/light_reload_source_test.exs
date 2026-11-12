defmodule HoodrideWeb.LightReloadSourceTest do
  @moduledoc """
  Light reload (owner, 2026-11-08) — the app half. A reload asks for the chat
  LIST (summaries); a chat's messages are loaded when it's opened
  (loadChat → GET /api/chat), held messages put together with them
  (HoodChatMerge, test_js/chatmerge.test.mjs). app.js is glue the Node tests
  can't load, so the rules a journey can't show are read from the file here;
  test_browser/lightreload.mjs and lightreload2.mjs run it for real.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  defp body(fun) do
    [b] = Regex.run(~r/(?:async )?function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "every /api/state ask is for the chat list; only a reload names the chat on screen" do
    asks = Regex.scan(~r/apiFetch\("\/api\/state[^)]*\)/, @app) |> Enum.map(&hd/1)
    assert length(asks) == 3
    assert Enum.all?(asks, &String.contains?(&1, "/api/state?chats=list")), inspect(asks)
    assert length(Regex.scan(~r/open_peer=/, @app)) == 1

    # inside the reload's fetch (asked again on each try), and only for a chat
    # on screen — not the list
    assert body("softReload") =~
             ~s[const onScreen = !$("chat").classList.contains("hidden") && state.chatView === "msgs" && state.chatPeer;]

    assert body("softReload") =~
             "(onScreen ? `&open_peer=${encodeURIComponent(onScreen.id)}` : \"\")"
  end

  test "a reload's chat: in full → loaded; a summary → not loaded, its summary kept" do
    h = body("hydrate")
    assert h =~ "if (Array.isArray(c.messages)) {"
    assert h =~ "chat.loaded = true;"
    assert h =~ "chat.loaded = false;"
    assert h =~ "chat.summary = { last: c.last || null, theirs: c.theirs || [] };"
    assert h =~ "settleLast(chat);"
  end

  test "a chat made on this phone is loaded; one already there keeps its state" do
    f = body("chatFor")
    assert f =~ ~r/if \(!chats\.has\(peer\)\) \{.*loaded: true, summary: null \}\);/s
    # (set only when it's made)
    assert length(Regex.scan(~r/loaded: true/, f)) == 1
  end

  test "opening a chat not loaded: Loading…, nothing read, no line — one load at a time" do
    o = body("openChat")
    [unloaded] = Regex.run(~r/if \(c\.loaded === false\) \{.*?\n    return;\n  \}/s, o)
    assert unloaded =~ "chatLineMsg = null;"
    assert unloaded =~ "c.failed = false;"
    assert unloaded =~ "if (!c.loading) loadChat(peer, c);"
    refute unloaded =~ "markSeen"
    refute unloaded =~ "unread = 0"
    refute unloaded =~ "openAtLine"
  end

  test "the load: marks on the chat, given up after 20 s with the answer's reading counted" do
    l = body("loadChat")
    assert @app =~ "const CHAT_LOAD_MS = 20000;"
    assert l =~ "c.loading = true;"
    assert l =~ "const timer = setTimeout(() => stop.abort(), CHAT_LOAD_MS);"
    assert l =~ "{ signal: stop.signal }"
    # the reading of the answer is inside, before the finally that stops the clock
    [try_part, after_finally] = String.split(l, "} finally {", parts: 2)
    assert try_part =~ "body = await res.json();"
    assert after_finally =~ "clearTimeout(timer);"
    assert after_finally =~ "c.loading = false;"
  end

  test "every outcome is for THIS chat object, or dropped (a reload or a closed chat since)" do
    l = body("loadChat")
    [_, after_finally] = String.split(l, "} finally {", parts: 2)
    [_, outcomes] = String.split(after_finally, "c.loading = false;\n  }", parts: 2)
    assert outcomes =~ ~r/\A\s*\/\/[^\n]*\n\s*if \(chats\.get\(peer\) !== c\) return;/
  end

  test "signed out or new Terms first; only Hood Ride's own 404 \"none\" closes the chat" do
    l = body("loadChat")
    assert l =~ "if (chats.get(peer) === c && refusedReload(await ownRefusal(res))) return;"
    {own, _} = :binary.match(l, "ownRefusal(res)")
    {ok, _} = :binary.match(l, "if (res.ok)")
    assert own < ok
    assert l =~ ~s[if (b && b.error === "none") outcome = "none";]
    assert l =~ ~s[if (outcome === "none") return closeChatWith(peer);]
    # anything else is a failure: Try again
    assert l =~ "c.failed = true;"
  end

  test "loaded: put together, then — only for the chat on screen — the line, read, drawn, placed" do
    l = body("loadChat")
    assert l =~ "c.msgs = HoodChatMerge.merge(body.messages.map(fromServer), c.msgs);"
    assert l =~ "c.loaded = true;"
    assert l =~ "c.summary = null;"
    [on_screen] = Regex.run(~r/if \(chatOnScreen\(peer\)\) \{\n.*?\n  \} else if/s, l)

    order = [
      "HoodChatScroll.firstUnread",
      "chatLineMsg =",
      "c.unread = 0;",
      "markSeen(peer);",
      "renderChat();",
      "openAtLine();"
    ]

    positions = Enum.map(order, fn s -> elem(:binary.match(on_screen, s), 0) end)
    assert positions == Enum.sort(positions), inspect(Enum.zip(order, positions))
    # the line is never set for a chat that isn't on screen
    assert length(Regex.scan(~r/chatLineMsg =/, l)) == 1
  end

  test "Loading… where the messages go, the header kept; the note tests failed, never loading" do
    r = body("renderChat")
    {header, _} = :binary.match(r, ~s[$("chat-form").classList.remove("hidden");])
    {branch, _} = :binary.match(r, "if (chatFor(state.chatPeer).loaded === false) {")
    assert header < branch
    assert r =~ "box.appendChild(chatLoadingNote(chatFor(state.chatPeer)));"

    n = body("chatLoadingNote")
    assert n =~ "if (!c.failed) {"
    refute n =~ "c.loading"
    # Try again opens it again (one load at a time, the failure cleared)
    assert n =~ ~s[again.id = "chatRetry";]
    assert n =~ "openChat(state.chatPeer)"
  end

  test "Send does nothing while the chat isn't loaded — before anything is drawn or cleared" do
    [h] = Regex.run(~r/\$\("chat-form"\)\.addEventListener\("submit".*?\n}\);\n/s, @app)
    {guard, _} = :binary.match(h, "if (chats.get(peer)?.loaded === false) return;")
    {push, _} = :binary.match(h, "chatFor(peer).msgs.push(sentMsg);")
    {clear, _} = :binary.match(h, ~s[input.value = "";])
    assert guard < push and guard < clear
  end

  test "a message heard twice counts once — only messages with an id, before anything changes" do
    r = body("receiveMsg")
    {dedupe, _} = :binary.match(r, "if (id != null && (c.msgs.some((m) => m.id === id)")
    {last, _} = :binary.match(r, "c.lastAt = at;")
    {push, _} = :binary.match(r, "c.msgs.push(msg);")
    assert dedupe < last and dedupe < push
    assert r =~ "((c.summary && c.summary.theirs) || []).some((m) => m.id === id)"
    # a note in a chat not loaded remembers what it came after
    assert r =~ "if (c.loaded === false && id == null) msg.after = newestKnownId(c);"
    # not drawn or read while loading; no banner for the chat on screen
    assert r =~ "const viewingThis = onScreen && c.loaded !== false;"
    assert r =~ "if (!onScreen && (!inRide || state.ride.peer === peer)) {"
  end

  test "unread counts the summary's messages too, each once" do
    t = body("theirMsgs")
    assert t =~ "const s = (c.summary && c.summary.theirs) || [];"
    assert t =~ "here.filter((m) => !ids.has(m.id))"
  end

  test "a reconnect: the list as before; a chat drawn before and back in full as before; else opened" do
    s = body("softReload")

    assert s =~
             "const wasLoaded = !!openChatPeerId && !!chats.get(state.chatPeer) && chats.get(state.chatPeer).loaded !== false;"

    assert s =~
             ~s[if (reopen && state.chatView !== "list" && !(wasLoaded && chatFor(reopen).loaded)) {\n    // on screen but not drawn before]

    [branch3] =
      Regex.run(
        ~r/!\(wasLoaded && chatFor\(reopen\)\.loaded\)\) \{.*?\n  \} else if \(reopen\) \{/s,
        s
      )

    assert branch3 =~ "openChat(reopen);"
    refute branch3 =~ "markSeen"
  end

  test "a chat's place in the list: its last message, else its summary's, else when it began" do
    s = body("settleLast")
    assert s =~ "if (last) {"
    assert s =~ "} else if (s) {"
    assert s =~ "c.lastAt = c.emptyAt;"
    # a refused message's chat goes back by the same rule
    assert @app =~
             "      settleLast(c);\n      if (!$(\"chat\").classList.contains(\"hidden\") && state.chatView === \"list\") renderChat();"
  end

  test "closing a chat — the server's word, or a load that finds it gone — one function" do
    # (and who ended it, if someone did — End chat, 2026-11-12)
    assert @app =~
             ~s[userChannel.on("chat_closed", ({ peer_id, ended_by }) =>\n    closeChatWith(]

    assert @app =~ "      realPeersById.get(peer_id),\n"

    assert body("closeChatWith") =~ "HoodBrowse.chatClosedActions({"
    assert body("closeChatWith") =~ "    endedBy,\n"
  end
end
