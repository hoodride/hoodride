defmodule Hoodride.FirstNameTest do
  @moduledoc """
  Strangers nearby see each other's FIRST name only (and the sign-in photo),
  as ride apps do. Name and photo come from the provider and can't be
  changed in Hood Ride — Google/Facebook own (and moderate) them; a change
  there arrives at the next sign-in.

  The first name is the provider's own field (Google `given_name`), not a
  split of the full name — "Mary Ann Smith" is "Mary Ann", and family-name-
  first names would split wrong. Without one, the full name's first word;
  without that, "Neighbor" — NEVER the email (the old fallback showed it).
  Invisible and direction-flipping characters are dropped (they fake names);
  the full name isn't stored at all.
  """
  use ExUnit.Case, async: true

  alias Hoodride.Accounts

  describe "first_name/2" do
    test "the provider's first-name field, as given" do
      assert Accounts.first_name("Mary Ann", "Mary Ann Smith") == "Mary Ann"
      assert Accounts.first_name("Dana", "Dana K") == "Dana"
    end

    test "no first-name field: the full name's first word" do
      assert Accounts.first_name(nil, "Mary Ann Smith") == "Mary"
      assert Accounts.first_name("  ", "Dana K") == "Dana"
      assert Accounts.first_name(nil, "Cher") == "Cher"
    end

    test "neither: Neighbor — never anything else (the email isn't passed in at all)" do
      assert Accounts.first_name(nil, nil) == "Neighbor"
      assert Accounts.first_name("", "   ") == "Neighbor"
    end

    test "spaces trimmed and collapsed" do
      assert Accounts.first_name("  Mary   Ann ", nil) == "Mary Ann"
    end

    test "invisible and direction-flipping characters are dropped" do
      # zero-width space/joiner, BOM, RTL override, isolates, a control char
      # (as code points: such characters in source are refused, rightly)
      c = fn cp -> <<cp::utf8>> end

      assert Accounts.first_name("Da" <> c.(0x200B) <> "na" <> c.(0x200D) <> c.(0xFEFF), nil) ==
               "Dana"

      assert Accounts.first_name(c.(0x202E) <> "asil" <> c.(0x2066) <> c.(0x2069), nil) == "asil"
      assert Accounts.first_name("Da" <> c.(0x07) <> "na", nil) == "Dana"

      assert Accounts.first_name(c.(0x200B) <> c.(0x202E), "Dana K") == "Dana",
             "nothing left: next fallback"
    end

    test "kept to 30 characters (graphemes, so no emoji or accent is cut in half)" do
      long = String.duplicate("é", 40)
      assert String.length(Accounts.first_name(long, nil)) == 30
    end

    test "Unicode-normalised (NFC): the same name typed two ways is the same text" do
      # "e" + a combining acute (U+0301) vs the single "é" (U+00E9)
      decomposed = "Jose" <> <<0x0301::utf8>>
      assert Accounts.first_name(decomposed, nil) == "Jos" <> <<0x00E9::utf8>>
    end
  end
end
