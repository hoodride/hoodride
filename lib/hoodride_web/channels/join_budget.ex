defmodule HoodrideWeb.JoinBudget do
  @moduledoc """
  One per-USER budget for channel joins (user, map, ride), checked FIRST in
  every join: a refused join does no work at all — it registers nothing,
  kicks no older session, asks no ride process.

  Joins were free and unlimited, and a user-channel join kicks the
  account's other session: a join loop was free work and a kick loop.

  Sized from what the real app does: a page load or a reconnect is at most
  3 joins (user, map, ride); a phone on flaky Wi-Fi reconnecting ~10 times
  a minute is ~30. So 31 at once, then one every 2 s — real use never
  meets it, a loop is held to one join per 2 s. A refused join answers the
  exact wait; Phoenix's client retries a refused join with its own backoff.
  """

  alias Hoodride.RateBudget

  @per_minute 30
  @burst 30

  @spec check(Phoenix.Socket.t()) :: :ok | {:error, map}
  def check(socket) do
    case RateBudget.spend(socket, :join, @per_minute, @burst) do
      {:ok, _} ->
        :ok

      {:deny, _} ->
        wait = RateBudget.wait_ms(socket, :join, @per_minute, @burst)
        {:error, %{reason: "rate_limited", retry_ms: max(wait, 1)}}
    end
  end
end
