defmodule HoodrideWeb.Journeys do
  @moduledoc """
  Every browser journey in test_browser/: a script that runs one (a line
  starting `await journey(`) — found, not listed (owner, 2026-11-05:
  nothing hard-coded; a new journey can't be left out of the gate). The
  helpers beside them (cdp.mjs, langcheck.mjs) and the tools (app.mjs,
  screenshot.mjs) run none.
  """

  @doc "The journeys' names (their files without .mjs), sorted."
  def list(dir \\ "test_browser") do
    Path.wildcard(Path.join(dir, "*.mjs"))
    |> Enum.filter(&(File.read!(&1) =~ ~r/^await journey\(/m))
    |> Enum.map(&Path.basename(&1, ".mjs"))
    |> Enum.sort()
  end
end
