defmodule Mix.Tasks.Hoodride.Limits do
  @shortdoc "Prints every limit the app sets (lib/hoodride/limits.ex)"
  @moduledoc """
  Every limit, grouped, with its number and why — the list in
  lib/hoodride/limits.ex (owner, 2026-11-12: "find me the limits").

      mix hoodride.limits

  Rate budgets show the numbers that ship; an environment that switches one
  off (dev, the load test) is noted.
  """
  use Mix.Task

  @impl true
  def run(_args) do
    Hoodride.Limits.all()
    |> Enum.chunk_by(&elem(&1, 0))
    |> Enum.each(fn [{group, _, _, _} | _] = entries ->
      Mix.shell().info("\n== #{group} ==")

      for {_g, name, value, note} <- entries do
        Mix.shell().info("  #{name}: #{show(name, value)}\n      #{note}")
      end
    end)
  end

  defp show(name, value) when is_list(value) do
    shown = Enum.map_join(value, ", ", fn {k, v} -> "#{k} #{v}" end)
    if name in Hoodride.Limits.budget_names(), do: shown <> off_here(name), else: shown
  end

  defp show(name, value) when is_integer(value) do
    s = Integer.to_string(value)
    if String.ends_with?(Atom.to_string(name), "_ms"), do: "#{s} (#{human(value)})", else: s
  end

  defp show(_name, value), do: to_string(value)

  defp off_here(name) do
    case Application.fetch_env(:hoodride, name) do
      {:ok, nil} -> "  [off in this environment: #{Mix.env()}]"
      _ -> ""
    end
  end

  defp human(ms) when rem(ms, 86_400_000) == 0, do: count(div(ms, 86_400_000), "day")
  defp human(ms) when rem(ms, 3_600_000) == 0, do: count(div(ms, 3_600_000), "hour")
  defp human(ms) when rem(ms, 60_000) == 0, do: count(div(ms, 60_000), "minute")
  defp human(ms) when rem(ms, 1_000) == 0, do: count(div(ms, 1_000), "second")
  defp human(ms), do: "#{ms} ms"

  defp count(1, unit), do: "1 #{unit}"
  defp count(n, unit), do: "#{n} #{unit}s"
end
