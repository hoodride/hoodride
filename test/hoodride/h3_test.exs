defmodule Hoodride.H3Test do
  @moduledoc """
  The server's H3 math (Hoodride.H3) says exactly what the app's own h3-js
  says: test/fixtures/h3_cases.json was made BY h3-js (h3_cases.mjs) — 605
  places worldwide, 300 of them around the 12 pentagons, the poles and the
  date line; and 1,800 ids that are not a block (other sizes, one digit
  off, a pentagon's missing child, garbage).
  """
  use ExUnit.Case, async: true
  alias Hoodride.H3

  @cases "test/fixtures/h3_cases.json" |> File.read!() |> Jason.decode!()

  test "every block: the same neighborhood and wider areas as h3-js" do
    for %{"spot" => spot, "cell" => cell, "parents" => parents} <- @cases["valid"] do
      assert H3.areas(spot) == {:ok, %{spot: spot, cell: cell, parents: parents}}, spot
    end
  end

  test "anything that isn't a real block-size id is refused" do
    assert length(@cases["invalid"]) > 1_000

    for s <- @cases["invalid"] do
      assert H3.areas(s) == :error, inspect(s)
    end

    for s <- [nil, 42, ["892a1072c63ffff"], %{}], do: assert(H3.areas(s) == :error)
  end

  test "uppercase is refused (h3-js takes it): one spelling per area" do
    for s <- @cases["uppercase"] do
      assert H3.areas(s) == :error, s
      assert {:ok, _} = H3.areas(String.downcase(s))
    end
  end

  test "the app sends only its block: no areas of its own to believe (app.js)" do
    js = File.read!("priv/static/app.js")
    assert js =~ ~s|userChannel.push("driver_update", { spot });|
    assert js =~ ~s|userChannel.push("hand_up", { spot });|
    refute js =~ "parents"
  end

  test "the resolutions are the app's (app.js)" do
    js = File.read!("priv/static/app.js")
    assert js =~ "const H3_DISPLAY_RES = #{H3.spot_res()};"
    assert js =~ "const H3_RES = #{H3.cell_res()};"
    assert js =~ "const AGG_RESES = #{inspect(H3.wider_reses())};"
  end
end
