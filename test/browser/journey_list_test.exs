defmodule HoodrideWeb.JourneyListTest do
  @moduledoc """
  The gate runs every journey in test_browser/, found rather than listed
  (owner, 2026-11-05): a new journey can't be left out. This checks the
  finding itself — no browser needed.
  """
  use ExUnit.Case, async: true

  defp journeys, do: HoodrideWeb.Journeys.list()

  test "every script that runs a journey is run; the helpers and tools are not" do
    found = journeys()
    assert found != []

    for path <- Path.wildcard("test_browser/*.mjs") do
      name = Path.basename(path, ".mjs")
      runs_one? = File.read!(path) =~ ~r/journey\(\s*["'`]/

      if runs_one?,
        do: assert(name in found, "#{name} runs a journey but the gate doesn't run it"),
        else: refute(name in found, "#{name} runs no journey")
    end
  end

  test "the helpers aren't journeys" do
    for helper <- ~w(cdp langcheck), do: refute(helper in journeys(), helper)
  end
end
