defmodule HoodrideWeb.RideActionGuardTest do
  @moduledoc """
  A double tap on "Request ride" / "Accept ride" (race audit, 2026-10-29):
  the app only learned "requested"/"in a ride" from the server's answer, so
  a quick second tap sent a second push — the server handled it right (no
  double request or ride) but the second answer showed a FALSE message:
  "You already have an open request" right after succeeding, or "Too late
  — the request was withdrawn" while the ride was starting.

  The standard fix, as researched: an in-flight flag set synchronously on
  the tap, repeat taps ignored; `aria-disabled` (keeps focus — not
  `disabled`), the button's text says what's happening ("Requesting…" —
  `aria-busy` is unreliable on buttons, so not used), plus a polite status
  message (VoiceOver may not read a changed label); reset on every outcome
  — ok, error, timeout (Phoenix: 10 s; a buffered push that timed out is
  never sent later, push.js); "already requested" or a timeout re-syncs
  from the server instead of a puzzling message. The server's repeat
  handling stays the real safeguard. (app.js is glue the Node tests can't
  load — this reads the file; the double tap itself is checked in Chrome.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")

  defp handler do
    [h] = Regex.run(~r/\$\("btn-ride-action"\)\.addEventListener\("click".*?\n}\);\n/s, @app)
    h
  end

  # one push's reply chain: from the push to the next push, or the
  # handler's end — replies hold `);` of their own, so no regex stop
  defp chain(push) do
    h = handler()
    {from, _} = :binary.match(h, ~s[.push("#{push}"])
    rest = binary_part(h, from, byte_size(h) - from)

    case :binary.match(rest, ".push(", scope: {1, byte_size(rest) - 1}) do
      {next, _} -> binary_part(rest, 0, next)
      :nomatch -> rest
    end
  end

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "a tap while one is on its way is ignored — the flag is set before anything is sent" do
    h = handler()
    assert h =~ "if (rideActionInFlight) return;"
    {set, _} = :binary.match(h, "startRideAction(")
    {push, _} = :binary.match(h, ".push(\"request_ride\"")
    assert set < push
  end

  test "while waiting: the text says so, aria-disabled (not disabled, not aria-busy), a polite status" do
    s = body("startRideAction")
    assert s =~ "rideActionInFlight = label;"
    assert s =~ ~s[$("ride-action-status").textContent = status;]
    r = body("refreshControls")
    assert r =~ ~s[action.setAttribute("aria-disabled", "true");]
    assert r =~ "action.textContent = rideActionInFlight;"
    # (named only in a comment: nothing SETS it)
    refute @app =~ ~s[setAttribute("aria-busy"]
    assert @html =~ ~s(<p id="ride-action-status" class="sr-only" role="status"></p>)
  end

  # each reply handler of one push, by outcome: the text from its
  # `.receive("<outcome>"` to the next `.receive(`
  defp replies(push) do
    chain(push)
    |> String.split(".receive(\"")
    |> Enum.drop(1)
    |> Map.new(fn part -> {part |> String.split("\"", parts: 2) |> hd(), part} end)
  end

  test "every outcome resets it: ok, error, timeout — for request and accept" do
    for push <- ["request_ride", "accept_request"], outcome <- ["ok", "error", "timeout"] do
      reply = replies(push)[outcome]
      assert reply, "#{push}: no #{outcome} handler"
      assert reply =~ "endRideAction()", "#{push}: #{outcome} doesn't reset"
    end

    e = body("endRideAction")
    assert e =~ "rideActionInFlight = null;"
    assert e =~ ~s[$("ride-action-status").textContent = "";]
  end

  test "'already requested' or a timeout re-syncs from the server, no puzzling message" do
    assert replies("request_ride")["error"] =~
             ~r/if \(e\.reason === "already_requested"\) return softReload\(\);/

    assert replies("request_ride")["timeout"] =~ ~r/endRideAction\(\);\s*softReload\(\);/
  end

  test "the button doesn't stay 'unavailable' once nothing is on its way" do
    assert body("refreshControls") =~ ~s[action.removeAttribute("aria-disabled");]
  end
end
