defmodule HoodrideWeb.ChatDirectionTest do
  @moduledoc """
  Chat in right-to-left languages (Arabic, Hebrew, Persian, Urdu) — owner,
  2026-10-29. Text whose direction isn't known in advance gets `dir="auto"`:
  the browser takes the direction from its first strong letter (W3C: "set
  the dir attribute to auto on forms and inserted text"; MDN: for "data
  coming from user input"). `dir` also ISOLATES the element, so hidden
  direction characters typed into a message stay inside its own bubble.
  The server's refusals are worded for the person (stacked_marks: "Zalgo"
  text). (app.js is glue the Node tests can't load — this reads the files;
  the live check is in Chrome and on the owner's iPhone.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  test "the message box takes the direction of what's typed" do
    assert @html =~ ~r/<input id="chat-input" dir="auto"/
  end

  test "every bubble takes its own text's direction" do
    assert body("appendBubble") =~ ~s[div.dir = "auto";]
  end

  test "the chat list's name and last message each take their own direction" do
    b = body("renderChat")
    assert b =~ ~s[strong.dir = "auto";]
    assert b =~ ~s[last.dir = "auto";]
  end

  # dir="auto" also ALIGNS a right-to-left line right: an Arabic preview
  # jumped to the far side of the row (Chrome check). The row's own side
  # stays — the page's start: left in English, right in Arabic, Hebrew,
  # Urdu (start, not left: the page mirrors — 2026-11-05); only the
  # reading order inside flips
  test "the name and preview stay under each other at the page's start" do
    css = File.read!("priv/static/styles.css")
    assert css =~ ~r/\.chat-item-info strong, \.chat-item-info \.muted \{ text-align: start; \}/
  end

  test "a refused message with stacked marks says why" do
    assert @app =~ ~r/stacked_marks: t\("[^"]+"\)/
  end
end
