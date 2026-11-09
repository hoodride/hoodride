defmodule HoodrideWeb.ChatRebuildTest do
  @moduledoc """
  Chats across a reconnect or reopening the app, and sending safely
  (owner, 2026-10-30):

    1. a new chat you had open (nothing sent yet) stays open across a
       reconnect — the server decides at Send whether they can be messaged
    2. the two "can't message them" refusals say so by name and close the
       chat: "isn't in view" keeps your text, "isn't available" drops it
    3. the box's text belongs to the person it was typed for: opening
       someone else's chat clears it (never sent to the wrong person)
    4. messages that came while you were disconnected or the app was closed
       are unread — a "read up to" bookmark per chat on the device
       (HoodReadStore, test_js/readstore.test.mjs), on the server's clock

  app.js is glue the Node tests can't load, so this reads the files.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @sw File.read!("priv/static/sw.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  defp send_handler do
    [send] = Regex.run(~r/\$\("chat-form"\)\.addEventListener\("submit".*?\n\}\);/s, @app)
    send
  end

  defp before?(text, a, b) do
    {at_a, _} = :binary.match(text, a)
    {at_b, _} = :binary.match(text, b)
    at_a < at_b
  end

  test "readstore.js loads before app.js, is cached offline, and served" do
    assert before?(@html, ~s(src="readstore.js"), ~s(src="app.js"))
    assert @sw =~ ~s("readstore.js")
    assert "readstore.js" in HoodrideWeb.static_paths()
  end

  describe "1. a new chat survives a reconnect" do
    test "the chat that was open comes back — a server chat or a new one" do
      b = body("softReload")
      assert b =~ "const reopen = openChatPeerId && realPeersById.get(openChatPeerId);"
      assert b =~ "if (reopen) {\n    state.chatPeer = reopen;"
      refute b =~ "if (reopen && chats.has(reopen))"
    end

    test "reopened is read: no unread, bookmark moved — if it's the chat on screen, not the list" do
      [reopen] = Regex.run(~r/if \(reopen\) \{.*?\n  \}/s, body("softReload"))

      assert reopen =~
               ~s[if (state.chatView !== "list") {\n      chatFor(reopen).unread = 0;\n      markSeen(reopen);]
    end
  end

  describe "2. can't message them" do
    test "by name: not in view (zoom in), not available" do
      s = send_handler()

      assert s =~
               ~s[out_of_view: t("{name} isn't in view — zoom in and find their car again", { name: peer.name }),]

      assert s =~ ~s[unavailable: t("{name} isn't available right now", { name: peer.name }),]
    end

    test "both close their chat if it's on screen (the list stays); not available drops the text" do
      s = send_handler()

      assert s =~
               ~s[if (e.reason === "out_of_view" || e.reason === "unavailable") {]

      [gone] =
        Regex.run(
          ~r/if \(e\.reason === "out_of_view" \|\| e\.reason === "unavailable"\) \{.*?\n        \}/s,
          s
        )

      # dropped from their chat's draft, and from the box if theirs is open
      assert gone =~ ~s[if (e.reason === "unavailable") {]
      assert gone =~ ~s[if (chats.has(peer)) chats.get(peer).draft = "";]
      assert gone =~ ~s[if (state.chatPeer === peer) {\n              $("chat-input").value = "";]
      # their chat closes if it's the one on screen (the list, if that's what
      # shows, stays — test_browser/chatsgone.mjs)
      assert gone =~
               ~s[const theirsOnScreen = !$("chat").classList.contains("hidden") && !listShowing && state.chatPeer === peer;]

      assert gone =~ "} else if (theirsOnScreen) closeChat();"
    end

    # the text goes back only into ITS person's box — never into another
    # chat you opened while it was on its way
    test "a refused or unanswered message's text goes back only to its own chat" do
      [unsay] = Regex.run(~r/const unsay = \(why\) => \{.*?\n    \};/s, send_handler())
      # back as ITS chat's draft (if nothing new was typed for them), in the
      # box only if their chat is the one open
      # (its chat: the one it was sent in — rebuilt if a reload dropped it,
      # never another chat: test_browser/reloadscreens.mjs, chatsgone.mjs)
      assert unsay =~ "let c = chats.get(peer);"
      assert unsay =~ "if (!c.draft) {\n        c.draft = text;"

      assert unsay =~ "if (state.chatPeer === peer) {\n          input.value = text;"
    end
  end

  # Request ride says the same, by name, as Send (owner, 2026-10-30)
  test "Request ride's refusals name the driver" do
    [req] = Regex.run(~r/\$\("btn-ride-action"\)\.addEventListener\("click".*?\n\}\);/s, @app)
    assert req =~ ~s[driver_busy: t("{name} is on a ride right now", { name: peer.name }),]

    assert req =~
             ~s[driver_offline: t("{name}'s gone offline — try another driver", { name: peer.name }),]

    assert req =~
             ~s[unavailable: t("{name} isn't available right now — try another driver", { name: peer.name }),]

    assert req =~
             ~s[out_of_view: t("{name} isn't in view — zoom in and find their car again", { name: peer.name }),]

    refute req =~ "That driver"
  end

  describe "3. the box belongs to one person" do
    # each chat keeps its own draft (owner, 2026-11-07): opening a chat puts
    # ITS text in the box — never another person's
    test "opening a chat fills the box with that chat's own draft" do
      b = body("openChat")

      assert b =~
               ~s[const c = chatFor(peer);\n  // the box holds THIS chat's draft (another's stays with them)\n  $("chat-input").value = c.draft;]

      refute @app =~ "chatDraftFor"
    end
  end

  describe "4. unread across a reconnect or reopening the app" do
    test "messages keep the server's time and id (rebuild and live alike)" do
      h = body("hydrate")
      # (one builder for a server message — a reload, and a chat's opening)
      assert h =~ "chat.msgs = c.messages.map(fromServer);"
      f = body("fromServer")
      assert f =~ "ts: m.ts,"
      assert f =~ "id: m.id,"
      assert body("loadChat") =~ "body.messages.map(fromServer)"
      assert h =~ "chatSkew = HoodChatList.skew(st.now, Date.now());"

      assert @app =~ "receiveMsg(peer, m.text, { ts: m.ts, id: m.id });"
      r = body("receiveMsg")
      assert r =~ "const id = meta ? meta.id : null;"
      assert r =~ "const at = meta ? HoodChatList.localAt(meta.ts, chatSkew) : Date.now();"
      assert r =~ "ts: meta ? meta.ts : null, id };"
    end

    test "the rebuild counts unread from the bookmark (not the old counts)" do
      assert body("hydrate") =~ "applyReadState();"
      a = body("applyReadState")
      assert a =~ "if (DEMO) return;"
      assert a =~ "HoodReadStore.reconcile(HoodReadStore.read(s, state.realUser.id), convs, null)"
      assert a =~ "if (c.server) c.unread = r.unread[p.id] || 0;"
      refute body("softReload") =~ "unread.get(p.id)"
    end

    test "only their messages from the server count (not your own, not local notes)" do
      assert body("theirMsgs") =~ ".filter((m) => !m.mine && m.id != null)"
    end

    test "opening a chat, or a message arriving in the one on screen, marks it read" do
      assert body("openChat") =~ "markSeen(peer);"
      [viewing] = Regex.run(~r/if \(viewingThis\) \{.*?\n  \}/s, body("receiveMsg"))
      assert viewing =~ "markSeen(peer);"
    end

    test "erased on sign-out, account deletion, and a signed-out start" do
      [logout] = Regex.run(~r/\$\("btn-logout"\)\.addEventListener\("click".*?\n\}\);\n/s, @app)
      assert logout =~ "HoodReadStore.forget(storageOrNull(), state.realUser.id);"

      # deleting the account: the same clean-up
      assert @app =~
               "HoodViewStore.forget(storageOrNull(), state.realUser.id);\n    HoodReadStore.forget(storageOrNull(), state.realUser.id);\n    loc.stop();"

      [out] = Regex.run(~r/onSignedOut: async \(\) => \{.*?\n  \},/s, @app)
      assert out =~ "HoodReadStore.forgetAll(storageOrNull());"
    end
  end
end
