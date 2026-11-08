defmodule HoodrideWeb.SessionStampWiringTest do
  @moduledoc """
  The app keeps its tab's stamp (Hoodride.SessionStamp) from BOTH join
  replies — the map's and the user channel's — so a lost user-join reply
  can't leave it without one (server review, 2026-11-08). Without a stamp,
  the next automatic reconnect counts as a choice and takes over from the
  device the user picked later. The server side:
  HoodrideWeb.SessionStampTest. app.js is glue the Node tests can't load,
  so this reads the file.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  test "the map join's reply sets the stamp" do
    [world] =
      Regex.run(~r/worldChannel\.join\(\)\.receive\("ok", \(reply\) => \{.*?\n  \}\)/s, @app)

    assert world =~ "if (reply && reply.stamp) sessionStamp = reply.stamp;"
  end

  test "the user join's reply sets it too" do
    assert length(String.split(@app, "if (reply && reply.stamp) sessionStamp = reply.stamp;")) ==
             3,
           "expected the line in both join handlers"
  end
end
