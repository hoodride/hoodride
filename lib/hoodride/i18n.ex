defmodule Hoodride.I18n do
  @moduledoc """
  The languages Hood Ride can show (owner, 2026-11-04), and their catalogs.

  The translators work in gettext's `.po` files
  (`priv/gettext/<lang>/LC_MESSAGES/default.po`, from the list
  `default.pot` — Hoodride.I18n.Extract). `mix hoodride.i18n.build` turns
  each into one small script the page loads right after i18n.js, before
  the app: `priv/static/i18n-<lang>.js`, which loads the catalog
  (HoodI18n.load) and translates the page's marked words
  (HoodI18n.translatePage). English is the messages themselves: no file.

  `en-XA` is a made-up language (pseudo-localization: every letter
  accented, a third longer) made from the list itself — the check that no
  English is left and longer words fit (the languages journey). Switched
  on in tests only.

  Which of these are switched on is the `LANGUAGES` setting (on/0): a new
  language stays off until its translation and its legal pages are
  reviewed.
  """

  # every language with a catalog, English first. A new one: its .po, then
  # its tag here (a test keeps the two the same)
  # (Apple's App Store list, one version of each language, plus Filipino
  # and Swahili — owner, 2026-11-04; Arabic, Hebrew, Urdu read right to
  # left: rtl/0)
  @known ~w(en es pt-BR fr it ca de nl sv da nb fi zh-Hans zh-Hant ja ko vi th id ms fil tr ru uk pl cs sk hr sl ro hu el sw hi bn mr te ta gu kn ml or pa ar he ur en-XA)

  # the pseudo-language's catalog comes from the list, not a .po
  @pseudo "en-XA"

  @doc "Every language the code knows."
  def known, do: @known

  @doc "The pseudo-language (made from the list itself)."
  def pseudo, do: @pseudo

  @doc """
  The languages switched on (`config :hoodride, :languages` — the
  LANGUAGES setting), English always among them, in the code's order.
  """
  def on do
    case Application.get_env(:hoodride, :languages, ["en"]) do
      # (tests: every language the code knows)
      :all -> @known
      wanted -> Enum.filter(@known, &(&1 == "en" or &1 in wanted))
    end
  end

  @rtl ~w(ar he ur)

  @doc "Whether a language reads right to left (the page then mirrors: dir=\"rtl\")."
  def rtl?(lang), do: lang in @rtl

  @doc "A language's script, as the page asks for it (none for English)."
  def script("en"), do: nil
  def script(lang), do: "i18n-#{lang}.js"

  # ----- catalogs: .po → the JSON i18n.js reads -----

  # CLDR's plural categories in gettext's msgstr[n] order, per language
  # (a .po's Plural-Forms numbers them; i18n.js picks by name, with
  # Intl.PluralRules). English and the pseudo-language: one, other
  # Spanish: "many" is exact millions ("1 000 000 de autos" — CLDR 42+)
  # (each language's forms for whole numbers, from Unicode CLDR as the
  # browser's Intl.PluralRules gives them; "many" in es/fr/it/pt/ca is
  # exact millions)
  @plural_categories %{
    "en-XA" => ~w(one other),
    "es" => ~w(one many other),
    "pt-BR" => ~w(one many other),
    "fr" => ~w(one many other),
    "it" => ~w(one many other),
    "ca" => ~w(one many other),
    "de" => ~w(one other),
    "nl" => ~w(one other),
    "sv" => ~w(one other),
    "da" => ~w(one other),
    "nb" => ~w(one other),
    "fi" => ~w(one other),
    "zh-Hans" => ~w(other),
    "zh-Hant" => ~w(other),
    "ja" => ~w(other),
    "ko" => ~w(other),
    "vi" => ~w(other),
    "th" => ~w(other),
    "id" => ~w(other),
    "ms" => ~w(other),
    "fil" => ~w(one other),
    "tr" => ~w(one other),
    "ru" => ~w(one few many),
    "uk" => ~w(one few many),
    "pl" => ~w(one few many),
    "cs" => ~w(one few other),
    "sk" => ~w(one few other),
    "hr" => ~w(one few other),
    "sl" => ~w(one two few other),
    "ro" => ~w(one few other),
    "hu" => ~w(one other),
    "el" => ~w(one other),
    "sw" => ~w(one other),
    "hi" => ~w(one other),
    "bn" => ~w(one other),
    "mr" => ~w(one other),
    "te" => ~w(one other),
    "ta" => ~w(one other),
    "gu" => ~w(one other),
    "kn" => ~w(one other),
    "ml" => ~w(one other),
    "or" => ~w(one other),
    "pa" => ~w(one other),
    "ar" => ~w(zero one two few many other),
    "he" => ~w(one two other),
    "ur" => ~w(one other)
  }

  @doc """
  The catalog i18n.js loads — `%{"lang" => lang, "messages" => %{key => text}}`
  — from a language's messages (Expo.Messages). Keys as i18n.js looks them
  up: context <> "\\u0004" <> msgid; singular <> "\\u0000" <> plural. Untranslated
  messages are left out (the English shows).
  """
  def catalog(lang, %Expo.Messages{messages: messages}) do
    categories = Map.fetch!(@plural_categories, lang)

    entries =
      for m <- messages, entry = entry(m, categories), entry != nil, into: %{}, do: entry

    %{"lang" => lang, "messages" => entries}
  end

  defp entry(%Expo.Message.Singular{msgctxt: ctx, msgid: id, msgstr: str}, _categories) do
    case text(str) do
      "" -> nil
      text -> {key(ctx, text(id)), text}
    end
  end

  defp entry(%Expo.Message.Plural{} = m, categories) do
    forms =
      for {cat, i} <- Enum.with_index(categories),
          text = text(Map.get(m.msgstr, i, [])),
          text != "",
          into: %{},
          do: {cat, text}

    if forms == %{},
      do: nil,
      else: {key(m.msgctxt, text(m.msgid) <> "\u0000" <> text(m.msgid_plural)), forms}
  end

  defp key(nil, id), do: id
  defp key(ctx, id), do: text(ctx) <> "\u0004" <> id

  defp text(iodata), do: IO.iodata_to_binary(iodata)

  @letters ~c"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
  @accented String.graphemes("áƀçðéƒĝĥíĵķĺɱñóþǫŕšţúṽŵẋýžÁƁÇÐÉƑĜĤÍĴĶĹṀÑÓÞǪŔŠŢÚṼŴẊÝŽ")
  @swap Map.new(Enum.zip(@letters, @accented))

  @doc """
  The made-up language's text for an English message: each letter
  accented, `{placeholders}` kept, a third longer — "⟦Ñééð á ŕíðé ~~~~⟧".
  """
  def pseudo_text(english) do
    swapped =
      ~r/(\{\w+\})/
      |> Regex.split(english, include_captures: true)
      |> Enum.map_join(fn part ->
        if part =~ ~r/^\{\w+\}$/,
          do: part,
          else: for(<<c::utf8 <- part>>, into: "", do: Map.get(@swap, c, <<c::utf8>>))
      end)

    "⟦#{swapped} #{String.duplicate("~", div(String.length(english) + 2, 3))}⟧"
  end

  @doc "The made-up language's messages: the list, every message given its pseudo text."
  def pseudo_messages(%Expo.Messages{} = pot) do
    messages =
      Enum.map(pot.messages, fn
        %Expo.Message.Singular{} = m ->
          %{m | msgstr: [pseudo_text(text(m.msgid))]}

        %Expo.Message.Plural{} = m ->
          %{
            m
            | msgstr: %{
                0 => [pseudo_text(text(m.msgid))],
                1 => [pseudo_text(text(m.msgid_plural))]
              }
          }
      end)

    %{pot | messages: messages}
  end

  @doc "The script for a catalog: load it, then translate the page's marked words."
  def script_source(%{"lang" => lang, "messages" => messages}) do
    # sorted: the file changes only when a translation does
    ordered =
      Jason.OrderedObject.new([
        {"lang", lang},
        {"messages", messages |> Enum.sort() |> Enum.map(&ordered/1) |> Jason.OrderedObject.new()}
      ])

    # (letters as they are; only the two line breaks JavaScript can't hold
    # in a string escaped)
    "// Made by `mix hoodride.i18n.build` from the translations; don't edit by hand.\n" <>
      "HoodI18n.load(" <>
      Jason.encode!(ordered, escape: :javascript_safe) <>
      ");\n" <>
      "HoodI18n.translatePage(document);\n"
  end

  defp ordered({key, forms}) when is_map(forms),
    do: {key, forms |> Enum.sort() |> Jason.OrderedObject.new()}

  defp ordered(pair), do: pair

  # ----- the server's own words -----

  @doc """
  A typed word compared the forgiving way (the app does the same,
  app.js plainWord): spaces around dropped, accents and dots dropped
  (decomposed, marks removed — "ȘTERGE" → "sterge", Turkish "SİL" → "sil"),
  lowercase, Turkish's dotless ı as i.
  """
  def typed_word(word) do
    word
    |> String.trim()
    |> :unicode.characters_to_nfd_binary()
    |> String.replace(~r/\p{M}/u, "")
    |> String.downcase()
    |> String.replace("ı", "i")
  end

  @doc """
  The words that confirm deleting an account, compared by typed_word/1: "delete" and its
  translation in every language the code knows (`tc("the word typed to
  delete the account", "DELETE")` — what each screen asks for).
  """
  def delete_words do
    key = "the word typed to delete the account\u0004DELETE"

    for lang <- @known, reduce: ["delete"] do
      words ->
        case messages(lang) do
          %{^key => word} when is_binary(word) and word != "" ->
            Enum.uniq([typed_word(word) | words])

          _ ->
            words
        end
    end
  end

  @doc """
  The server's own message in `lang` (`t(lang, "…")`, collected like the
  app's): from that language's script, read once; English if none.
  """
  def t(lang, msgid) do
    case messages(lang) do
      %{^msgid => text} when is_binary(text) and text != "" -> text
      _ -> msgid
    end
  end

  defp messages("en"), do: %{}

  defp messages(lang) do
    case :persistent_term.get({__MODULE__, lang}, nil) do
      nil ->
        found = read_messages(lang)
        :persistent_term.put({__MODULE__, lang}, found)
        found

      found ->
        found
    end
  end

  # Reviewed (2026-11-04): `lang` is one of @known (callers pick it with
  # HoodrideWeb.Lang, from on/0) — never a name from a request as written
  # sobelow_skip ["Traversal.FileModule"]
  defp read_messages(lang) do
    with true <- lang in @known,
         path = Application.app_dir(:hoodride, Path.join("priv/static", script(lang))),
         {:ok, source} <- File.read(path),
         [_, json] <- Regex.run(~r/^HoodI18n\.load\((.*)\);$/m, source),
         {:ok, %{"messages" => messages}} <- Jason.decode(json) do
      messages
    else
      _ -> %{}
    end
  end
end
