defmodule HoodrideWeb.NavigateLinkTest do
  @moduledoc """
  Navigate is a real link the driver taps (navlink.js; owner, 2026-10-29:
  window.open(…, "_blank") left a blank tab behind on iPhone once the
  Google Maps app took the link). The tap fills in the destination and how
  to open it, then the browser follows it as the driver's own tap — what
  hands a link to an app (Apple's engineer: "display the link with an <a
  href and let the user tap the link"). (app.js is glue the Node tests
  can't load — this reads the files; the live check is on a phone.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @sw File.read!("priv/static/sw.js")

  test "Navigate is a link, looking like the other ride buttons" do
    assert @html =~
             ~r/<a id="btn-navigate" class="btn btn-pill hidden" href="[^"]+"[^>]*><img class="emoji-icon" src="compass.svg" alt="" data-emoji="&#x1F9ED;" \/>Navigate<\/a>/
  end

  test "navlink.js is loaded before app.js, cached offline, and served" do
    {mod, _} = :binary.match(@html, ~s(src="navlink.js"))
    {app, _} = :binary.match(@html, ~s(src="app.js"))
    assert mod < app
    assert @sw =~ ~s("navlink.js")
    assert "navlink.js" in HoodrideWeb.static_paths()
  end

  test "the tap sets the link's address and target; no window.open to Maps anywhere" do
    [handler] = Regex.run(~r/\$\("btn-navigate"\)\.addEventListener\("click".*?\n}\);\n/s, @app)
    assert handler =~ "HoodNavLink.href("
    assert handler =~ "HoodNavLink.target(PLATFORM)"
    assert handler =~ "e.preventDefault()"
    refute @app =~ ~r/window\.open\([^)]*google\.com\/maps/
  end

  # it goes to the RIDER (or the meetup pin) — Hood Ride has no destination.
  # After "I'm here" it read as "to the destination" (owner, 2026-10-29):
  # gone once arrived, like "I'm here" itself
  test "Navigate shows only on the way to the rider, not after I'm here" do
    assert @app =~
             ~s[toggle("btn-navigate", !rider && inRide && state.ride.status === "connected");]
  end

  test "a link-button doesn't look like a link (no underline, button colors)" do
    css = File.read!("priv/static/styles.css")
    assert css =~ ~r/a\.btn \{[^}]*text-decoration: none;/
  end
end
