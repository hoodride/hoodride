defmodule Hoodride.I18n.ExtractTest do
  @moduledoc """
  The message collector (owner, 2026-11-04): every `t("…")` in our scripts
  reaches the translator's list; nothing in a comment or a string does; a
  message built at run time is refused.
  """
  use ExUnit.Case, async: true

  alias Hoodride.I18n.Extract

  defp ids(src) do
    {:ok, found} = Extract.scan_js(src, "x.js")
    Enum.map(found, &{&1.context, &1.msgid, &1.plural})
  end

  test "t, tc, tn, and HoodI18n.t" do
    src = """
    t("Need a ride");
    el.textContent = HoodI18n.t("Go online");
    tc("button", "Drive");
    tn("{count} car", "{count} cars", n);
    """

    assert ids(src) == [
             {nil, "Need a ride", nil},
             {nil, "Go online", nil},
             {"button", "Drive", nil},
             {nil, "{count} car", "{count} cars"}
           ]
  end

  test "JavaScript escapes, emoji and placeholders come through as written" do
    src = ~S|t("Say \"hi\" to {name}"); t("✋ Need a ride"); t("caf\u00e9 \u{1F697}");|

    assert ids(src) == [
             {nil, ~s(Say "hi" to {name}), nil},
             {nil, "✋ Need a ride", nil},
             {nil, "café 🚗", nil}
           ]
  end

  test "line numbers are the real ones" do
    {:ok, [m]} = Extract.scan_js("a\nb\n\nt(\"x\")", "x.js")
    assert m.line == 4
  end

  test "not a call: inside comments, strings, templates, regexes, or another name" do
    src = """
    // t("in a line comment")
    /* t("in a block
       comment") */
    const a = "t(\\"in a string\\")";
    const b = 'also t("x") in a string';
    const c = `t("in a template")`;
    const re = /t\\("in a regex"\\)/;
    const url = "https://example.com"; t("after a url");
    format("not ours"); obj.t("a method"); cut("no");
    """

    assert ids(src) == [{nil, "after a url", nil}]
  end

  test "inside a template's ${…} it's code again: found" do
    src =
      ~S|el.innerHTML = `<b>${t("Rides")}</b> and ${n > 1 ? tn("{count} car", "{count} cars", n) : ""}`;|

    assert ids(src) == [{nil, "Rides", nil}, {nil, "{count} car", "{count} cars"}]
    # braces inside the ${…} don't end it early
    assert ids(~S|`${({a: 1}).a}${t("after braces")}`|) == [{nil, "after braces", nil}]
  end

  # the mask keeps every byte where it was: found positions ARE the
  # source's (a call's arguments are read from the source at that spot)
  test "the mask keeps every byte and line, in all our scripts" do
    for f <- Extract.sources() do
      src = File.read!(f)
      masked = Extract.mask(src)
      assert byte_size(masked) == byte_size(src), f
      assert :binary.matches(masked, "\n") == :binary.matches(src, "\n"), f
    end

    for src <- [~S|a = "unclosed ✋|, ~S|b = 'x' + "y✋" ; c = `t ${"z"} 🚗`|, "/* never closed 🚗"] do
      assert byte_size(Extract.mask(src)) == byte_size(src), src
    end
  end

  test "a division isn't a regex: what follows is still code" do
    assert ids(~S|x = a / b; t("still found"); y = c / 2;|) == [{nil, "still found", nil}]
  end

  test "a message built at run time is refused, with where it is" do
    for bad <- [
          ~S|t(name)|,
          ~S|t(`hi ${name}`)|,
          ~S|t("a" + b)|,
          ~S|tc(ctx, "x")|,
          ~S|tn("one", others, n)|,
          ~S|t('single')|
        ] do
      assert {:error, [problem]} = Extract.scan_js("\n" <> bad, "y.js"), bad
      assert problem =~ "y.js:2:"
    end
  end

  test "the list file: one entry per message, sorted, gettext's format, read back by expo" do
    {:ok, found} =
      Extract.scan_js(~S|t("b"); t("a"); t("b"); tc("ctx", "a"); tn("one", "many", 2);|, "z.js")

    pot = Extract.pot(found)

    assert pot =~ ~s(msgid "a"\nmsgstr "")
    assert pot =~ ~s(msgctxt "ctx"\nmsgid "a")
    assert pot =~ ~s(msgid "one"\nmsgid_plural "many")
    assert pot =~ "#: z.js"
    refute pot =~ ~r/#: z\.js:\d/

    {:ok, parsed} = Expo.PO.parse_string(pot)
    keys = Enum.map(parsed.messages, &Expo.Message.key/1)
    assert length(keys) == 4 and length(Enum.uniq(keys)) == 4
  end

  # a local variable named t (or tc, tn) hides the translation helper in its
  # function: t("…") there calls the wrong thing. Navigate's code had one
  # (`const t = …navTarget(…)`); renaming it missed two lines once
  # (2026-11-04) — so: no script names anything t, tc or tn, except taking
  # them from the helper
  test "nothing hides t, tc or tn" do
    decl =
      ~r/(?:\b(?:const|let|var)\s+(?:t|tc|tn)\b(?!\s*,|\s*\})|[(,]\s*(?:t|tc|tn)\s*(?:[,)=]|=>)|(?<![\w$.])(?:t|tc|tn)\s*=>|\bfunction\s*\w*\s*\([^)]*\b(?:t|tc|tn)\b)/

    for f <- Extract.sources() do
      code = Extract.mask(File.read!(f))

      bad =
        for {line, n} <- code |> String.split("\n") |> Enum.with_index(1),
            not String.match?(line, ~r/^\s*const \{ [ tcn,]+ \} = (?:HoodI18n|I18n);\s*$/),
            Regex.match?(decl, line),
            do: "#{f}:#{n}: #{String.trim(line)}"

      assert bad == [], Enum.join(bad, "\n")
    end
  end

  test "the app's scripts: all readable, the shipped list up to date" do
    assert {:ok, found} = Extract.scan_all()
    assert File.read!("priv/gettext/default.pot") == Extract.pot(found)
    assert "hoodride.i18n.extract --check" in Mix.Project.config()[:aliases][:precommit]
  end
end
