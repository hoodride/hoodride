defmodule HoodrideWeb.ChatLimitTest do
  @moduledoc """
  The message box's 500 characters (owner, 2026-10-29), as the design
  systems do it (GOV.UK, Scottish Government, USWDS):

    * counted as people see characters (HoodChatList.count — the browser's
      maxlength counted 👨‍👩‍👧‍👦 as 11), so no maxlength;
    * a warning, never a cut: from 400 "100 characters left", over 500
      "20 characters too many" — in words, not color alone;
    * Send stays tappable (no greyed-out button: GOV.UK, BC, Bristol); over
      the limit it sends nothing, keeps the text and says why — announced
      at once (role="alert"), it answers the tap;
    * screen readers hear the count politely once typing pauses (~500 ms:
      WebAIM, Oracle JET), and the region only goes live once typing starts
      (USWDS 3.14: VoiceOver read counts at page load).

  (app.js is glue the Node tests can't load — this reads the files; the
  counting is in test_js/chatlist; the live check is in Chrome.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @css File.read!("priv/static/styles.css")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  defp submit do
    [b] = Regex.run(~r/\$\("chat-form"\)\.addEventListener\("submit".*?\n}\);\n/s, @app)
    b
  end

  test "the box has no maxlength (it counted hidden pieces)" do
    [input] = Regex.run(~r/<input id="chat-input"[^>]*>/, @html)
    refute input =~ "maxlength"
  end

  test "the counter, a quiet screen-reader copy, and an alert sit above the box" do
    [chat] = Regex.run(~r/<p id="chat-count".*?<form id="chat-form"/s, @html)
    assert chat =~ ~s(<p id="chat-count" class="chat-count hidden" aria-hidden="true"></p>)
    # no aria-live yet: it's switched on once typing starts
    assert chat =~ ~s(<p id="chat-count-sr" class="sr-only"></p>)
    assert chat =~ ~s(<p id="chat-count-alert" class="sr-only" role="alert"></p>)
  end

  test "typing updates the counter; screen readers hear it politely after a pause" do
    # typing: the open chat's draft (owner, 2026-11-07), then the counter
    [typing] =
      Regex.run(~r/\$\("chat-input"\)\.addEventListener\("input", \(\) => \{.*?\n\}\);/s, @app)

    assert typing =~ ~s[chats.get(state.chatPeer).draft = $("chat-input").value;]
    assert typing =~ "updateChatCount();"
    b = body("updateChatCount")
    assert b =~ "HoodChatList.limit(HoodChatList.count("
    assert b =~ ~s[sr.setAttribute("aria-live", "polite");]
    assert b =~ ~r/setTimeout\(.*, 500\)/s
  end

  test "Send over the limit: nothing sent, text kept, and it says why — at once" do
    b = submit()
    {check, _} = :binary.match(b, "HoodChatList.count(text) > HoodChatList.MAX_CHARS")
    {push, _} = :binary.match(b, "chatFor(peer).msgs.push(sentMsg)")
    assert check < push
    assert b =~ "shorten your message to send"
    assert b =~ ~s[$("chat-count-alert").textContent =]
  end

  test "a sent message clears the counter too" do
    # (and its chat's draft: sent, nothing left unsent)
    assert submit() =~
             ~r/input\.value = "";\s*chatFor\(peer\)\.draft = "";\s*updateChatCount\(\);/
  end

  test "over the limit reads in red AND in words; sr-only hides text only visually" do
    assert @css =~ ~r/\.chat-count\.over \{[^}]*color: var\(--danger\)/
    assert @css =~ ~r/\.sr-only \{[^}]*clip: rect\(0, 0, 0, 0\)/
  end
end
