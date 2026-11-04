defmodule HoodrideWeb.ErrorJSONTest do
  # pure functions: no connection, no database (it needn't queue for one)
  use ExUnit.Case, async: true

  test "renders 404" do
    assert HoodrideWeb.ErrorJSON.render("404.json", %{}) == %{errors: %{detail: "Not Found"}}
  end

  test "renders 500" do
    assert HoodrideWeb.ErrorJSON.render("500.json", %{}) ==
             %{errors: %{detail: "Internal Server Error"}}
  end
end
