defmodule HoodrideWeb.CarSheetFocusTest do
  @moduledoc """
  The car box ("Your car" / "Add your car") opens with the cursor on its
  TITLE, not in the color dropdown: on iPhone, focusing a <select> opens
  its picker wheel at once — the owner saw the color list pop up before
  touching anything (2026-10-28). WAI-ARIA's dialog pattern allows focusing
  a static element at the top when the first field would get in the way:
  screen readers still start inside the box and announce its title; Tab
  reaches Color next. (app.js is glue the Node tests can't load — this
  reads the files; the live check is in Chrome.)
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")

  defp open_car_sheet do
    [body] = Regex.run(~r/function openCarSheet\(.*?\n}\n/s, @app)
    body
  end

  test "opening moves focus to the title, never into the color dropdown" do
    body = open_car_sheet()
    assert body =~ ~s/$("car-title").focus()/
    refute body =~ ~s/$("car-color").focus()/
  end

  test "the title can take focus from code, but isn't a Tab stop" do
    assert @html =~ ~r/<h2 id="car-title"[^>]*\stabindex="-1"/
  end
end
