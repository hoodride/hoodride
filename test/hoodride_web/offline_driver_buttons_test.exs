defmodule HoodrideWeb.OfflineDriverButtonsTest do
  @moduledoc """
  "Decline" with no "Accept ride" means a rider waits on a driver who's
  OFFLINE (Accept needs you online). The owner saw it in the demo,
  2026-10-29. The real app can't get there:

    * the server refuses a request to an offline driver, and going
      offline declines everyone waiting (requests_edge_test.exs:
      "you cannot even ask a driver who is not on the map", "going
      offline declines all waiting riders and notifies each one")
    * the driver's own app mirrors that the moment it goes offline
      (pushDriverOffline) — checked here

  The demo's pretend riders broke the server's rule: their scripted reply
  made them "ask for a ride" even while you were offline. Now they only
  ask when you're online, as the server would allow. (app.js is glue the
  Node tests can't load — this reads the file; the live check is in
  Chrome.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "Decline needs a waiting rider; Accept needs that AND you online" do
    assert @app =~ ~r/toggle\("btn-decline", [^;]*state\.chatPeer\.pending === true/
    assert @app =~ ~r/state\.chatPeer\.pending && state\.online/
  end

  test "real app: going offline tells the server AND clears every waiting rider on the phone" do
    b = body("pushDriverOffline")
    assert b =~ ~s[userChannel.push("driver_offline", {})]
    assert b =~ "if (p.pending) p.pending = false;"
    assert body("setOnline") =~ "pushDriverOffline();"
  end

  test "demo: a pretend rider only asks for a ride while you're online" do
    assert @app =~
             ~r/if \(peer\.kind === "rider" && !peer\.pending && !state\.ride && state\.mode === "driver" && state\.online\) \{\s*peer\.pending = true;/
  end
end
