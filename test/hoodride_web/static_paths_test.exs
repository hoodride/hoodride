defmodule HoodrideWeb.StaticPathsTest do
  @moduledoc """
  Every file the page loads is one the server serves (2026-11-14): the
  server serves only the files it lists (HoodrideWeb.static_paths/0), and a
  new script added to the page but not to the list was simply missing in
  the browser — `turnstile.js`, caught by its journey, not by any test.
  """
  use ExUnit.Case, async: true

  test "every script and stylesheet the page names is on the served list" do
    page = File.read!("priv/static/index.html")
    served = MapSet.new(HoodrideWeb.static_paths())

    named =
      Regex.scan(~r/<(?:script|link)[^>]*?(?:src|href)="([^"?#:]+)"/, page)
      |> Enum.map(fn [_, f] -> f |> String.trim_leading("/") |> String.split("/") |> hd() end)
      |> Enum.uniq()

    assert named != []
    missing = Enum.reject(named, &MapSet.member?(served, &1))
    assert missing == [], "named by the page, not served: #{inspect(missing)}"
  end
end
