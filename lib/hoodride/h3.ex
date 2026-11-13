defmodule Hoodride.H3 do
  @moduledoc """
  The little H3 the server needs: is this a real map-area id, and which
  bigger areas contain it. No library: an H3 cell id is a 64-bit number
  with a fixed layout (h3geo.org/docs/library/index/cell), so a parent is
  the same number with its resolution changed and its finer digits blanked.

  Why the server does this itself (owner, 2026-11-13, step 5): the app used
  to send its block AND the wider areas it should be counted in, and the
  server believed the list — one car could count in 4 areas anywhere. Now
  the app sends only its block (`spot`) and everything else comes from it
  here (`areas/1`). Checked against the app's own h3-js: Hoodride.H3Test.

  The resolutions are the app's (priv/static/app.js H3_DISPLAY_RES, H3_RES,
  AGG_RESES — a test keeps them equal).
  """
  import Bitwise

  # the spot (a block), the cell (topic / street-map filing), the wider
  # areas the zoomed-out counts use, widest last
  @spot_res 9
  @cell_res 8
  @wider_reses [7, 5]

  # the 12 base cells that are pentagons: one of their 7 children is missing
  @pentagons [4, 14, 24, 38, 49, 58, 63, 72, 83, 97, 107, 117]

  @doc false
  def spot_res, do: @spot_res
  @doc false
  def cell_res, do: @cell_res
  @doc false
  def wider_reses, do: @wider_reses

  @doc """
  A car's or a ✋'s areas from its spot: `{:ok, %{spot, cell, parents}}`,
  or `:error` when the spot isn't a real block-size area id.
  """
  def areas(spot) do
    case parse(spot) do
      {:ok, n} when (n >>> 52 &&& 0xF) == @spot_res ->
        {:ok,
         %{
           spot: spot,
           cell: format(parent(n, @cell_res)),
           parents: Enum.map(@wider_reses, &format(parent(n, &1)))
         }}

      _ ->
        :error
    end
  end

  @doc "A valid cell id as the app writes it (lowercase hex) → `{:ok, integer}` | `:error`."
  def parse(s) when is_binary(s) and byte_size(s) == 15 do
    with true <- s =~ ~r/\A[0-9a-f]{15}\z/,
         {n, ""} <- Integer.parse(s, 16),
         true <- valid?(n) do
      {:ok, n}
    else
      _ -> :error
    end
  end

  def parse(_), do: :error

  @doc "The resolution of a valid cell id string, or nil."
  def resolution(s) do
    case parse(s) do
      {:ok, n} -> n >>> 52 &&& 0xF
      :error -> nil
    end
  end

  # h3's isValidCell: high bit 0, mode 1 (a cell), reserved bits 0, a real
  # base cell, digits 0–6 down to the resolution and 7 below it, and a
  # pentagon's first non-zero digit never 1 (its deleted child)
  defp valid?(n) do
    res = n >>> 52 &&& 0xF
    base = n >>> 45 &&& 0x7F
    used = Enum.map(1..res//1, &digit(n, &1))

    n >>> 63 == 0 and (n >>> 59 &&& 0xF) == 1 and (n >>> 56 &&& 0x7) == 0 and base < 122 and
      Enum.all?(used, &(&1 <= 6)) and
      Enum.all?((res + 1)..15//1, &(digit(n, &1) == 7)) and
      not (base in @pentagons and Enum.find(used, 0, &(&1 != 0)) == 1)
  end

  defp digit(n, r), do: n >>> ((15 - r) * 3) &&& 7

  defp parent(n, res) do
    n = (n &&& bnot(0xF <<< 52)) ||| res <<< 52
    Enum.reduce((res + 1)..15//1, n, fn r, acc -> acc ||| 7 <<< ((15 - r) * 3) end)
  end

  defp format(n), do: n |> Integer.to_string(16) |> String.downcase()
end
