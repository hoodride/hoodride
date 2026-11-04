defmodule HoodrideWeb.FindingPulseTest do
  @moduledoc """
  While Need a ride / GO ONLINE finds your location, the 📍 on the button
  pulses gently (owner, 2026-11-01): only after 1 s (NN/g: a looped
  animation under 1 s distracts), slow and small, never for "Reduce
  motion". The journey (test_browser/map.mjs) watches it run and stop.
  """
  use ExUnit.Case, async: true

  @static Path.expand("../../priv/static", __DIR__)
  @css File.read!(Path.join(@static, "styles.css"))
  @app File.read!(Path.join(@static, "app.js"))

  test "the pin on a searching button pulses: 1.2 s a beat, after 1 s" do
    assert @css =~
             ".btn.searching .emoji-icon { animation: seeking 1.2s ease-in-out 1s infinite; }"

    assert @css =~ "@keyframes seeking"
  end

  test "never for someone who asked their phone for less motion" do
    assert @css =~
             ~r/@media \(prefers-reduced-motion: reduce\) \{\s*\.btn\.searching \.emoji-icon \{ animation: none; \}/
  end

  test "a button is 'searching' only while its tap waits for a location" do
    assert @app =~ ~s[$("btn-hand").classList.toggle("searching", !!loc.pending.hand);]
    assert @app =~ ~s[$("btn-online").classList.toggle("searching", !!loc.pending.online);]
  end
end
