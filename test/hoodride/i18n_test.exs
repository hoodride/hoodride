defmodule Hoodride.I18nTest do
  @moduledoc """
  The languages (stage 1f, 2026-11-04): which are known and switched on,
  the catalogs built from the translations, the made-up language, and the
  server's own words.
  """
  use ExUnit.Case, async: false

  alias Expo.Message
  alias Hoodride.I18n

  test "the languages known are English, the made-up en-XA, and one per translation folder" do
    folders =
      "priv/gettext/*/LC_MESSAGES/default.po"
      |> Path.wildcard()
      |> Enum.map(&(&1 |> Path.split() |> Enum.at(2) |> String.replace("_", "-")))

    assert Enum.sort(I18n.known()) == Enum.sort(["en", I18n.pseudo() | folders])
    assert hd(I18n.known()) == "en"
  end

  describe "switched on (LANGUAGES)" do
    setup do
      before = Application.get_env(:hoodride, :languages)
      on_exit(fn -> Application.put_env(:hoodride, :languages, before) end)
    end

    test "English always; only known ones; the code's order" do
      Application.put_env(:hoodride, :languages, ["en-XA", "xx", "klingon"])
      assert I18n.on() == ["en", "en-XA"]
      Application.delete_env(:hoodride, :languages)
      assert I18n.on() == ["en"]
    end

    test "hoodride.app: unset, English only — Spanish and the made-up one are on in tests alone" do
      # only the LANGUAGES setting switches one on outside tests
      for f <- ~w(config/config.exs config/prod.exs config/dev.exs),
          do: refute(File.read!(f) =~ ":languages", f)

      assert File.read!("config/runtime.exs") =~ ~s[if languages = System.get_env("LANGUAGES") do]
      assert File.read!("config/test.exs") =~ ~s[config :hoodride, :languages, ~w(en es en-XA)]
    end
  end

  test "a catalog: plain, with a context, plurals by name; untranslated left out" do
    messages = %Expo.Messages{
      messages: [
        %Message.Singular{msgid: ["Save"], msgstr: ["Guardar"]},
        %Message.Singular{msgctxt: ["car color"], msgid: ["Gray"], msgstr: ["Gris"]},
        %Message.Singular{msgid: ["Not yet"], msgstr: [""]},
        %Message.Plural{
          msgid: ["{count} car"],
          msgid_plural: ["{count} cars"],
          msgstr: %{0 => ["{count} auto"], 1 => ["{count} autos"]}
        },
        %Message.Plural{msgid: ["a"], msgid_plural: ["b"], msgstr: %{0 => [""], 1 => [""]}}
      ]
    }

    assert I18n.catalog("en-XA", messages) == %{
             "lang" => "en-XA",
             "messages" => %{
               "Save" => "Guardar",
               "car color\u0004Gray" => "Gris",
               "{count} car\u0000{count} cars" => %{
                 "one" => "{count} auto",
                 "other" => "{count} autos"
               }
             }
           }
  end

  test "the made-up language: letters accented, placeholders kept, a third longer" do
    assert I18n.pseudo_text("Need a ride") == "⟦Ñééð á ŕíðé ~~~~⟧"
    assert I18n.pseudo_text("Ride with {name}") =~ "{name}"
    # every ASCII letter swapped: no plain English left
    refute I18n.pseudo_text("The quick brown fox jumps over the lazy dog") =~ ~r/[A-Za-z]/
    refute I18n.pseudo_text("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG") =~ ~r/[A-Za-z]/
  end

  test "a catalog's script: loads it, then translates the page; read back the same" do
    catalog = %{
      "lang" => "en-XA",
      "messages" => %{"b" => "B", "a" => %{"other" => "x", "one" => "y"}}
    }

    js = I18n.script_source(catalog)

    assert js =~
             ~s[HoodI18n.load({"lang":"en-XA","messages":{"a":{"one":"y","other":"x"},"b":"B"}});]

    assert js =~ "HoodI18n.translatePage(document);"
    [_, json] = Regex.run(~r/^HoodI18n\.load\((.*)\);$/m, js)
    assert Jason.decode!(json) == catalog
  end

  test "the built scripts are the ones served, each up to date" do
    for lang <- I18n.known(), script = I18n.script(lang) do
      assert script in HoodrideWeb.static_paths()
      assert File.read!(Path.join("priv/static", script)) =~ ~s[HoodI18n.load({"lang":"#{lang}"]
    end

    assert I18n.script("en") == nil
    assert "hoodride.i18n.build --check" in Mix.Project.config()[:aliases][:precommit]
  end

  test "the server's own words: in the language's catalog, English if none" do
    msg = "Too many failed sign-ins from your network — try again later."
    assert I18n.t("en", msg) == msg
    assert I18n.t("en-XA", msg) == I18n.pseudo_text(msg)
    assert I18n.t("en-XA", "not one of ours") == "not one of ours"
    assert I18n.t("xx", msg) == msg
  end
end
