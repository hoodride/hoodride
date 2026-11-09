defmodule HoodrideWeb.SignedOutWiringTest do
  @moduledoc """
  The app when its sign-in is gone (2026-11-08, sign-in tokens): every join
  refused "signed_out" (HoodrideWeb.SessionGate) stops reconnecting and asks
  the server — really signed out → the sign-in screen; still signed in (the
  pass came from an older sign-in) → a fresh pass, connect again. Never a
  reload loop. And only Hood Ride's OWN "not signed in" / "Terms first"
  answer reloads — never any 401/403 (a proxy's challenge page). app.js is
  glue the Node tests can't load, so this reads the file; the journey
  test_browser/signedout.mjs runs it for real.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  defp handler(start_regex) do
    [h] = Regex.run(start_regex, @app)
    h
  end

  test "the user, map and ride joins all handle signed_out FIRST" do
    user =
      handler(
        ~r/\.receive\("error", \(e\) => \{\n      if \(signedOutReply\(e\)\) onJoinSignedOut\(\);\n      else if \(sessionMovedReply\(e\)\) onSessionMoved\(\);\n(?:      \/\/.*\n)*      else if \(e && e\.reason === "not_yours"\) onSessionMoved\(\);\n      else transientBanner/
      )

    world =
      handler(
        ~r/\}\)\.receive\("error", \(e\) => \{\n    if \(signedOutReply\(e\)\) onJoinSignedOut\(\);\n    else if \(sessionMovedReply\(e\)\) onSessionMoved\(\);\n  \}\);/
      )

    ride =
      handler(
        ~r/\.receive\("error", \(e\) => \{\n      if \(signedOutReply\(e\)\) return onJoinSignedOut\(\);\n      if \(sessionMovedReply\(e\)\) return onSessionMoved\(\);/
      )

    assert user && world && ride
  end

  test "signed_out: stop, ask the server, reload only on its own refusal, else reconnect" do
    [f] = Regex.run(~r/function onJoinSignedOut\(\) \{.*?\n\}\n/s, @app)
    assert f =~ "if (signedOutCheck) return;"
    assert f =~ "socket.disconnect();"
    assert f =~ ~s[const res = await apiFetch("/api/socket_token");]
    assert f =~ "if (await ownRefusal(res)) return location.reload();"
    assert f =~ "socket.connect();"
  end

  # signed out on another device: this one's reconnect is refused — its
  # FIRST failure asks for a new pass at once (→ the sign-in screen in
  # seconds); after that at most once a minute (a server down a while)
  test "the first failed connect after being connected asks at once; later ones once a minute" do
    [connect] = Regex.run(~r/async function connectSocket\(\) \{.*?\n\}\n/s, @app)
    [on_open] = Regex.run(~r/socket\.onOpen\(\(\) => \{.*?\n  \}\);/s, connect)
    assert on_open =~ "failsSinceOpen = 0;"
    [on_error] = Regex.run(~r/socket\.onError\(\(\) => \{.*?\n  \}\);/s, connect)

    assert on_error =~
             "if ((failsSinceOpen++ === 0 && since > 5_000) || since > 60_000) refreshSocketToken();"
  end

  test "only Hood Ride's own answer counts as 'not signed in' (or 'Terms first')" do
    [f] = Regex.run(~r/async function ownRefusal\(res\) \{.*?\n\}\n/s, @app)
    assert f =~ "if (res.status !== 401 && res.status !== 403) return false;"
    assert f =~ ~s[body.error === "unauthenticated" || body.error === "terms"]

    [refresh] = Regex.run(~r/async function refreshSocketToken\(\) \{.*?\n\}\n/s, @app)
    assert refresh =~ "if (await ownRefusal(res)) return location.reload();"
    refute refresh =~ "res.status === 401"
  end
end
