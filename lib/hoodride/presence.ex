defmodule Hoodride.Presence do
  @moduledoc """
  Is someone still AROUND? One rule for what memory keeps per person
  (owner, 2026-11-17): their blocks now (Hoodride.Blocks), their sign-ins
  next — read from the database on first need, kept while they're around,
  dropped by the Sweeper once they're not (and read again when next
  needed). One place, so the two can't drift apart.

  Around = any of:
    * their app is connected (Hoodride.Geo.connected?/1);
    * they left within the presence grace (`Limits.presence_grace_ms`) —
      the grace their car, ✋ and chats get;
    * they're in a ride, or have a ride request open (asking or asked).
  """
  # (seconds, as the presence clock — Hoodride.Geo)
  @grace div(Hoodride.Limits.presence_grace_ms(), 1000)

  @doc "`now`: seconds, the presence clock."
  def around?(user_id, now \\ System.system_time(:second)) do
    Hoodride.Geo.connected?(user_id) or
      in_grace?(Hoodride.Geo.grace_since(user_id), now) or
      Hoodride.Rides.ride_id_of_user(user_id) != nil or
      Hoodride.Requests.open_request_of(user_id) != nil or
      Hoodride.Requests.pending_for_driver(user_id) != []
  end

  defp in_grace?(nil, _now), do: false
  defp in_grace?(since, now), do: now - since <= @grace
end
