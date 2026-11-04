defmodule HoodrideWeb.ChatHeaderPhotoTest do
  @moduledoc """
  (owner, 2026-10-29)
    * an open chat shows the other person's photo in its header — the same
      small round photo as the chat list, 🙂 without one; not beside every
      bubble (one-to-one: left is them, right is you)
    * the demo doesn't pop a card open when a pretend driver messages you:
      in the real app a message is a banner and an unread count, never a
      card (only a tap on a marker opens one)
  (app.js is glue the Node tests can't load — this reads the files; the
  live check is in Chrome.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "the chat header has the photo, before the name" do
    [header] = Regex.run(~r/<div class="chat-header">.*?id="chat-close"/s, @html)
    {photo, _} = :binary.match(header, ~s(id="chat-photo"))
    {title, _} = :binary.match(header, ~s(class="chat-title"))
    assert photo < title
    assert header =~ ~r/<img id="chat-photo" class="avatar avatar-mini hidden" src="" alt="" \/>/
  end

  test "an open chat shows that person's photo (their initial without one); the list hides it" do
    b = body("renderChat")

    assert b =~
             ~s[$("chat-photo").src = state.chatPeer.photo || HoodAvatar.url(state.chatPeer.name);]

    assert b =~ ~s[$("chat-photo").classList.remove("hidden");]
    assert b =~ ~s[$("chat-photo").classList.add("hidden");]
  end

  test "demo: a pretend driver's message after ✋ doesn't open their card" do
    [ping] = Regex.run(~r/handPingTimer = setTimeout\(\(\) => \{.*?\}, 6000\);/s, @app)
    assert ping =~ "receiveMsg(nearest,"
    refute ping =~ "openPeerCard("
  end
end
