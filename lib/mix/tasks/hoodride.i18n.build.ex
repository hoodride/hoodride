defmodule Mix.Tasks.Hoodride.I18n.Build do
  @shortdoc "Turns the translations into the scripts the page loads (priv/static/i18n-<lang>.js)"
  @moduledoc """
  For each language the code knows (Hoodride.I18n.known/0) but English:
  its catalog script, `priv/static/i18n-<lang>.js` — from its `.po`
  (`priv/gettext/<lang>/LC_MESSAGES/default.po`), or, for the made-up
  `en-XA`, from the list itself (`default.pot`).

      mix hoodride.i18n.build          # write them
      mix hoodride.i18n.build --check  # fail if one is out of date (in `mix precommit`)
  """
  use Mix.Task

  alias Hoodride.I18n

  @pot "priv/gettext/default.pot"

  @impl true
  def run(args) do
    stale =
      for lang <- I18n.known(), lang != "en", reduce: [] do
        stale ->
          path = Path.join("priv/static", I18n.script(lang))
          source = lang |> catalog() |> I18n.script_source()
          current = if File.exists?(path), do: File.read!(path), else: nil

          cond do
            current == source ->
              Mix.shell().info("#{path}: up to date")
              stale

            "--check" in args ->
              [path | stale]

            true ->
              File.write!(path, source)
              Mix.shell().info("#{path}: written")
              stale
          end
      end

    if stale != [],
      do:
        Mix.raise(
          "Out of date — run `mix hoodride.i18n.build` and commit: " <> Enum.join(stale, ", ")
        )
  end

  defp catalog(lang) do
    messages =
      if lang == I18n.pseudo(),
        do: @pot |> Expo.PO.parse_file!() |> I18n.pseudo_messages(),
        else: Expo.PO.parse_file!("priv/gettext/#{po_dir(lang)}/LC_MESSAGES/default.po")

    I18n.catalog(lang, messages)
  end

  # gettext's folders use "_" ("pt_BR"); our tags "-"
  defp po_dir(lang), do: String.replace(lang, "-", "_")
end
