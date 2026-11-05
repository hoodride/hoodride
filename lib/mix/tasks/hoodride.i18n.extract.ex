defmodule Mix.Tasks.Hoodride.I18n.Extract do
  @shortdoc "Collects every message the app shows into priv/gettext/default.pot"
  @moduledoc """
  Writes `priv/gettext/default.pot` — every `t("…")`, `tc(…)`, `tn(…)` in
  our scripts (Hoodride.I18n.Extract), the list a translator works from.

      mix hoodride.i18n.extract          # write it
      mix hoodride.i18n.extract --check  # fail if it's out of date (in `mix precommit`)

  A call it can't read (a message built at run time) fails either way.
  """
  use Mix.Task

  alias Hoodride.I18n.Extract

  @pot "priv/gettext/default.pot"

  @impl true
  def run(args) do
    found =
      case Extract.scan_all() do
        {:ok, found} ->
          found

        {:error, problems} ->
          Mix.raise("Messages that can't be translated:\n  " <> Enum.join(problems, "\n  "))
      end

    pot = Extract.pot(found)
    current = if File.exists?(@pot), do: File.read!(@pot), else: nil

    cond do
      "--check" in args and current != pot ->
        Mix.raise("#{@pot} is out of date — run `mix hoodride.i18n.extract` and commit it")

      "--check" in args ->
        Mix.shell().info("#{@pot}: up to date (#{count(found)} messages)")

      current == pot ->
        Mix.shell().info("#{@pot}: unchanged (#{count(found)} messages)")

      true ->
        File.mkdir_p!(Path.dirname(@pot))
        File.write!(@pot, pot)
        Mix.shell().info("#{@pot}: written (#{count(found)} messages)")
    end
  end

  defp count(found), do: found |> Enum.uniq_by(&{&1.context, &1.msgid, &1.plural}) |> length()
end
