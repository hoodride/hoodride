defmodule HoodrideWeb.Reach do
  @moduledoc """
  Who you may contact. ONE rule for a first message and a ride request alike:

    - a relationship (a chat, an open request either way) → always;
    - otherwise (a COLD contact) only someone on YOUR screen right now:
        * a car in a hex your map channel is receiving cars for, or
        * as an online driver, a raised hand in a hex it's receiving hands for.

  "On your screen" is asked of the map channel on the SAME socket (it holds
  the watched topics; we never copy them): one GenServer call, made only
  for cold contacts. No map channel, or no answer → refused, the safe side.
  The map channel never calls back, so the two can't deadlock.

  Every refusal is the same `unavailable` — a missing id included — so
  nobody can probe who exists or who is where. The one exception:
  `out_of_view` when a viewer tries a car that IS on the map but off their
  screen (cars are public while online; it tells the rider what to do).
  Natural consequences: drivers can't cold-contact drivers (a driver's map
  never holds cars); mid-ride nobody new (it holds nothing).

  Why: ids used to be enough. Message any id → a conversation exists →
  reload → /api/state hands you that stranger's name and photo.
  """

  alias Hoodride.{Geo, Roles}

  @spec check(Phoenix.Socket.t(), integer) :: :related | :cold | {:error, map}
  def check(socket, other) do
    me = socket.assigns.user_id

    cond do
      Hoodride.Chat.exists?(me, other) or Hoodride.Requests.open_between?(me, other) -> :related
      on_screen?(socket, me, other) -> :cold
      out_of_view?(me, other) -> {:error, %{reason: "out_of_view"}}
      true -> {:error, %{reason: "unavailable"}}
    end
  end

  defp on_screen?(socket, me, other) do
    cond do
      # (the car can leave between these two reads: no cell → not on screen)
      car_cell = Geo.driver_cell(other) ->
        holding?(socket, me, Geo.geo_topic(:drivers, car_cell))

      # the sender's live role first: a "yes" from a map channel that hasn't
      # yet processed a role change can't count
      Roles.of(me) == :driver ->
        case Geo.hand_cell(other) do
          nil -> false
          cell -> holding?(socket, me, Geo.geo_topic(:hands, cell))
        end

      true ->
        false
    end
  end

  # a viewer reaching for a car that is online, just not in view
  defp out_of_view?(me, other), do: Roles.of(me) == :viewer and Geo.driver_on_map?(other)

  defp holding?(socket, me, topic) do
    # our OWN map channel: the one on this very socket (during a newest-wins
    # handover an older one can briefly still be registered)
    case for(
           {pid, transport} <- Registry.lookup(Hoodride.WorldChannels, me),
           transport == socket.transport_pid,
           do: pid
         ) do
      [pid | _] ->
        try do
          GenServer.call(pid, {:holding?, topic})
        catch
          :exit, _ -> false
        end

      [] ->
        false
    end
  end
end
