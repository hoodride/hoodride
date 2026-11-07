defmodule HoodrideWeb.OfflineTest do
  @moduledoc """
  When Hood Ride can't be reached (owner, 2026-10-30). The app used to say
  "✋ Nearby drivers can see you need a ride", "🟢 You're online", "Ride
  ended" or show a message as sent while the server had heard nothing, and
  nothing said the connection was down. The rule: anything that needs the
  server is refused while not connected — "Can't reach Hood Ride — try
  again", nothing changes on screen. The connection rule is in sync.js
  (createConnWatch, test_js/sync.test.mjs); app.js is glue the Node tests
  can't load, so this reads the files.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @sw File.read!("priv/static/sw.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  defp click(id) do
    [h] = Regex.run(~r/\$\("#{id}"\)\.addEventListener\("click", \(\) => \{.*?\n\}\);/s, @app)
    h
  end

  defp before?(text, a, b) do
    {at_a, _} = :binary.match(text, a)
    {at_b, _} = :binary.match(text, b)
    at_a < at_b
  end

  test "one message for it" do
    assert @app =~ ~s[const CANT_REACH = () => t("Can't reach Hood Ride — try again");]
  end

  test "the socket tells the watch when it opens, closes or fails" do
    [connect] = Regex.run(~r/async function connectSocket\(.*?\n}\n/s, @app)
    assert connect =~ "connWatch.up();"
    assert connect =~ ~s[socket.onClose(() => connWatch.down());]
    [on_error] = Regex.run(~r/socket\.onError\(\(\) => \{.*?\n  \}\);/s, connect)
    assert on_error =~ "connWatch.down();"
  end

  # in a ride the ride stays on screen (who's coming, which car), with the
  # connection news after it; otherwise "Reconnecting…" comes before all
  test "lost: 'Reconnecting…' — in a ride after the ride's own banner (not in the demo)" do
    b = body("contextBanner")
    assert b =~ "const lost = !DEMO && connWatch.lost();"
    assert b =~ ~s[if (lost && !state.ride) return t("Reconnecting to Hood Ride…");]
    assert b =~ "const text = situationBanner();"
    assert b =~ ~s[return lost ? t("{status} · Reconnecting…", { status: text }) : text;]
    assert before?(b, "if (lost && !state.ride)", "situationBanner()")
    assert body("situationBanner") =~ "loc.banner()"
  end

  test "a change redraws the banner, unless a message is on screen (it restores it after)" do
    [w] = Regex.run(~r/const connWatch = HoodSync\.createConnWatch\(\{.*?\n\}\);/s, @app)
    assert w =~ "if (!bannerTimer) setBanner(contextBanner());"
  end

  test "live means the user channel is joined" do
    assert @app =~ ~s[const liveNow = () => !!userChannel && userChannel.state === "joined";]
  end

  # in setHand/setOnline, so the tap that waits for GPS is refused too if
  # the connection dropped meanwhile. The message comes after the step that
  # called it: a GPS reading completes the tap, then redraws the banner
  # (locator.js) — that wiped the message (browser journey, 2026-10-30)
  test "✋ up and Go online are refused while not live — no false 'they can see you'" do
    for {fun, flag} <- [{"setHand", "up"}, {"setOnline", "on"}] do
      b = body(fun)

      assert b =~
               ~s[if (#{flag} && !DEMO && !liveNow()) {\n    refreshControls();\n    queueMicrotask(() => transientBanner(CANT_REACH()));\n    return;\n  }]

      assert before?(b, "!liveNow()", "state."), "#{fun}: refused before anything changes"
    end
  end

  # the tap itself, up or down, refused at once — no GPS wait for something
  # that can't go through. Down: else the screen says you're off the map
  # while drivers (riders) still see you. Cancelling a GPS wait is this
  # phone's own business: allowed
  test "✋ and Go online taps are refused while not live (up or down)" do
    hand = click("btn-hand")
    assert hand =~ "else if (!liveNow() && !loc.pending.hand) transientBanner(CANT_REACH());"
    assert before?(hand, "!liveNow()", "loc.tapHand()")

    online = click("btn-online")
    assert online =~ "else if (!liveNow() && !loc.pending.online) transientBanner(CANT_REACH());"
    assert before?(online, "!liveNow()", "loc.tapOnline()")
  end

  test "switching Drive/Ride with ✋ up or online is refused while not live" do
    mode = click("btn-mode")

    assert mode =~
             "if (!DEMO && (state.handRaised || state.online) && !liveNow()) return transientBanner(CANT_REACH());"

    assert before?(mode, "!liveNow()", "state.mode = ")
  end

  test "End ride / Cancel request are refused while not live" do
    b = body("endRide")
    assert b =~ "if (!DEMO && !liveNow()) return transientBanner(CANT_REACH());"
    assert before?(b, "!liveNow()", "cancel_request")
  end

  # a message is never shown as sent unless it went
  test "Send: refused while not live, before the bubble; the text stays in the box" do
    [send] = Regex.run(~r/\$\("chat-form"\)\.addEventListener\("submit".*?\n\}\);/s, @app)
    assert send =~ "if (!DEMO && !liveNow()) return transientBanner(CANT_REACH());"
    assert before?(send, "!liveNow()", "chatFor(peer).msgs.push(sentMsg)")
    assert before?(send, "!liveNow()", ~s[input.value = "";])
  end

  test "Send: no answer is not 'sent' — the bubble goes, the text comes back" do
    [send] = Regex.run(~r/\$\("chat-form"\)\.addEventListener\("submit".*?\n\}\);/s, @app)
    assert send =~ ~s[.receive("timeout", () => unsay(t("Message didn't send — try again")));]
    [unsay] = Regex.run(~r/const unsay = \(why\) => \{.*?\n    \};/s, send)
    assert unsay =~ "bubble.remove();"
    # (back only into its own chat's box: HoodrideWeb.ChatRebuildTest)
    assert unsay =~
             "c.draft = text;\n        if (state.chatPeer === peer) {\n          input.value = text;"

    assert unsay =~ "transientBanner(why);"
  end

  # Cloudflare answers with its own error page while the server is down: a
  # network-first worker that saved every answer replaced the good copy
  # (the behaviour: test_js/sw.test.mjs)
  test "the offline copy keeps only good answers, never an error page" do
    # (the save: only inside the ok branch — a redirect or an error never)
    assert @sw =~ "if (res.ok) {
          const copy = res.clone();"

    [saving] =
      Regex.run(
        ~r/if \(res\.ok\) \{.*?
        \}/s,
        @sw
      )

    assert saving =~ "c.put(e.request, copy);"
    assert length(String.split(@sw, "c.put(")) - 1 == 2, "a save outside the ok branch"
  end
end
