defmodule HoodrideWeb.ChatAndPinTest do
  @moduledoc """
  (owner, 2026-10-29) The chat follows new messages only if you're at the
  bottom — scrolled up, it holds and shows "↓ New message" (rules:
  chatscroll.js, test_js/chatscroll.test.mjs). Meet here / Move pin zoom
  the map in to street level (PIN_ZOOM 16: side streets named, a fingertip
  about one corner), centred on you or on the pin — never zooming out.
  (app.js is glue the Node tests can't load — this reads the files; the
  live check is in Chrome.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @sw File.read!("priv/static/sw.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  describe "chat scroll" do
    test "chatscroll.js is loaded before app.js, cached offline, and served" do
      {mod, _} = :binary.match(@html, ~s(src="chatscroll.js"))
      {app, _} = :binary.match(@html, ~s(src="app.js"))
      assert mod < app
      assert @sw =~ ~s("chatscroll.js")
      assert "chatscroll.js" in HoodrideWeb.static_paths()
    end

    test "the button is in the chat, hidden until needed, and says what it does" do
      assert @html =~
               ~r/<button id="chat-jump"[^>]*class="chat-jump hidden"[^>]*>↓ New message<\/button>/
    end

    # "at the bottom" is REMEMBERED (chatStick), not measured when a message
    # comes: the keyboard opening moved the list without the reader
    # scrolling, and the next reply showed the button (owner's iPhone)
    test "a new bubble asks the remembered state, not a fresh measurement" do
      b = body("appendBubble")
      assert b =~ "const wasAtBottom = chatStick.stuck;"
      refute b =~ "HoodChatScroll.atBottom("
      assert b =~ "HoodChatScroll.onNew({ mine, wasAtBottom })"
    end

    test "every app-made scroll is the app's own (never read as yours)" do
      assert body("chatScrollTo") =~ "chatStick.ownScroll(appScrollTop);"

      assert @app =~
               ~r/copyChip\.scrollIntoView\(\{ block: "nearest" \}\);\s*appScrollTop = box\.scrollTop;\s*chatStick\.ownScroll\(appScrollTop\);/
    end

    test "the keyboard: both the list's size and the visible area keep a stuck reader at the bottom" do
      assert @app =~ ~s[new ResizeObserver(onChatResize).observe($("chat-messages"))]
      assert @app =~ ~s[window.visualViewport.addEventListener("resize", onChatResize)]
      b = body("onChatResize")
      assert b =~ "chatStick.resizeStarted()"
      assert b =~ "chatStick.resizeDone()"
    end

    test "the browser's scroll anchoring can't move the list" do
      css = File.read!("priv/static/styles.css")
      assert css =~ ~r/\.chat-messages \{[^}]*overflow-anchor: none;/
    end

    test "opening a chat goes to the newest, with no button left over" do
      assert body("renderChat") =~ "hideChatJump();"
    end

    test "tapping the button, or reaching the bottom yourself, clears it" do
      assert @app =~ ~r/\$\("chat-jump"\)\.addEventListener\("click"/

      # your own scroll updates the remembered state; stuck again → no button
      assert @app =~
               ~r/chatStick\.onScroll\(\$\("chat-messages"\)\);\s*if \(chatStick\.stuck\) hideChatJump\(\);/
    end
  end

  describe "the pin hint stays while the pin is armed" do
    # (owner, 2026-10-29: in the demo, "Tap the map where you want to meet"
    # was replaced within 1.5 s by the driver's "on the way" update)
    @hint "📍 Tap the map where you want to meet"

    test "it's part of the one banner rule, before the ride's own lines" do
      b = body("situationBanner")
      {hint, _} = :binary.match(b, ~s[if (state.pinArmed) return t("#{@hint}");])
      {ride, _} = :binary.match(b, "if (state.ride) {")
      assert hint < ride
    end

    test "arming and disarming just redraw the banner from that rule" do
      [handler] = Regex.run(~r/\$\("btn-pin"\)\.addEventListener\("click".*?\n}\);\n/s, @app)
      assert handler =~ "setBanner(contextBanner());"
      refute handler =~ ~s[setBanner("]
    end

    test "the demo's moving driver doesn't write over it" do
      assert @app =~
               ~r/else if \(!state\.pinArmed\) \{\s*(\/\/[^\n]*\n\s*)*setBanner\(CAR \+ t\("\{name\} is on the way", \{ name: d\.name \}\)/
    end
  end

  describe "the meetup pin" do
    test "street level: PIN_ZOOM is 16" do
      assert @app =~ ~r/^const PIN_ZOOM = 16;/m
    end

    test "Meet here / Move pin centre on the pin (or you) and only ever zoom IN" do
      [handler] = Regex.run(~r/\$\("btn-pin"\)\.addEventListener\("click".*?\n}\);\n/s, @app)

      assert handler =~
               "map.easeTo({ center: [at.lng, at.lat], zoom: Math.max(map.getZoom(), PIN_ZOOM) })"

      assert handler =~ "const at = state.pinPos || state.me;"
      assert handler =~ ~r/if \(state\.pinArmed\) \{/
    end
  end
end
