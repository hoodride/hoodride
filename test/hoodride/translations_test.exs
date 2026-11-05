defmodule Hoodride.TranslationsTest do
  @moduledoc """
  Every translation (priv/gettext/<lang>/LC_MESSAGES/default.po), checked
  the way a reviewer would — languages, stage 2 (owner, 2026-11-04):

  - complete: every message translated, every plural form — a gap would
    show English in the middle of the language;
  - the same {placeholders}: a lost {name} drops the name; a misspelled one
    shows "{nombre}" on screen;
  - names stay names: Hood Ride, Google, GitHub… are never translated (the
    owner: "Hood Ride stays the same in all languages");
  - the glossary's never-words (Spanish: "coger" — vulgar in much of Latin
    America);
  - a message starting with an emoji starts with the same one (it's an icon);
  - Spanish: a question or exclamation opens with ¿ or ¡.
  """
  use ExUnit.Case, async: true

  alias Expo.Message

  @names ["Hood Ride", "Google", "GitHub", "Discord", "Facebook", "Safari"]
  # (every form of "coger": cog- before e/i, coj- before a/o — "cojo" slipped
  # past the first version)
  @never %{
    "es" => [
      ~r/\b(cog(e|er|es|en|emos|ió|í|ía|ías|ían|iendo|ido|ida|erá|ería)|coj(o|a|as|an|amos))\b/iu
    ]
  }

  defp text(nil), do: nil
  defp text(iodata), do: IO.iodata_to_binary(iodata)

  # {english, translation} per form: a plural's every form against its
  # plural English (Spanish's one-form against the singular)
  defp pairs(lang) do
    po =
      Expo.PO.parse_file!("priv/gettext/#{String.replace(lang, "-", "_")}/LC_MESSAGES/default.po")

    Enum.flat_map(po.messages, fn
      %Message.Singular{} = m ->
        [{text(m.msgid), text(m.msgstr)}]

      %Message.Plural{} = m ->
        Enum.map(Enum.sort(m.msgstr), fn {i, str} ->
          {if(i == 0, do: text(m.msgid), else: text(m.msgid_plural)), text(str)}
        end)
    end)
  end

  defp languages,
    do: Hoodride.I18n.known() -- ["en", Hoodride.I18n.pseudo()]

  test "there are translations to check" do
    assert "es" in languages()
  end

  test "complete: every message, every plural form" do
    for lang <- languages() do
      po =
        Expo.PO.parse_file!(
          "priv/gettext/#{String.replace(lang, "-", "_")}/LC_MESSAGES/default.po"
        )

      pot = Expo.PO.parse_file!("priv/gettext/default.pot")
      assert length(po.messages) == length(pot.messages), lang

      blank = for {en, tr} <- pairs(lang), String.trim(tr) == "", do: en
      assert blank == [], "#{lang}: not translated: #{inspect(blank)}"
    end
  end

  test "the same placeholders, each one" do
    holes = &(Regex.scan(~r/\{\w+\}/, &1) |> List.flatten() |> Enum.sort())

    for lang <- languages(), {en, tr} <- pairs(lang) do
      assert holes.(tr) == holes.(en), "#{lang}: #{inspect(en)} → #{inspect(tr)}"
    end
  end

  test "names stay names" do
    for lang <- languages(),
        {en, tr} <- pairs(lang),
        name <- @names,
        String.contains?(en, name) do
      assert String.contains?(tr, name), "#{lang}: #{name} lost in #{inspect(tr)}"
    end
  end

  test "the glossary's never-words" do
    for lang <- languages(), {_en, tr} <- pairs(lang), re <- Map.get(@never, lang, []) do
      refute tr =~ re, "#{lang}: #{inspect(tr)}"
    end
  end

  test "an icon first stays first" do
    first = fn s -> s |> String.graphemes() |> List.first() end
    icon? = fn g -> g =~ ~r/^[\x{1F000}-\x{1FAFF}\x{2190}-\x{2BFF}\x{2600}-\x{27BF}]/u end

    for lang <- languages(), {en, tr} <- pairs(lang), icon?.(first.(en)) do
      assert first.(tr) == first.(en), "#{lang}: #{inspect(en)} → #{inspect(tr)}"
    end
  end

  test "Spanish: questions open with ¿, exclamations with ¡" do
    for {en, tr} <- pairs("es") do
      if tr =~ "?", do: assert(tr =~ "¿", "#{inspect(en)} → #{inspect(tr)}")
      if tr =~ "!", do: assert(tr =~ "¡", "#{inspect(en)} → #{inspect(tr)}")
    end
  end

  test "the checks see what they guard (each on a made-up bad line)" do
    holes = &(Regex.scan(~r/\{\w+\}/, &1) |> List.flatten() |> Enum.sort())
    refute holes.("Viaje con {nombre}") == holes.("Ride with {name}")
    assert "Lo cogí" =~ hd(@never["es"])
    assert "Sí, te cojo" =~ hd(@never["es"])
    assert "Que lo coja" =~ hd(@never["es"])
    refute "Recoger a Ana" =~ hd(@never["es"]), "recoger is fine"
    refute "Escoge un color" =~ hd(@never["es"]), "escoger is fine"
  end
end
