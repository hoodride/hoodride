defmodule Hoodride.BlockEffects do
  @moduledoc """
  What a block ends, at once (owner, 2026-11-15) — called right after the
  block is saved (Hoodride.Blocks), so anything new between the two is
  already refused:

    1. a request between them, either way: withdrawn (the driver told it
       was cancelled) or declined (the rider told it was declined) — as any
       other; nobody is told it's a block;
    2. a ride together: ended (the other told "ended", as any ending). A
       ride STARTING in that same moment isn't missed: its own last look,
       once its seats are its own, sees the block (Requests.accept);
    3. their chat: closed with a neutral line — "Chat with … ended": no
       "ended by", and not "they've been away" (untrue: the other was here);
    4. their maps: each one's map channel drops the other's marker at once
       (WorldChannel `{:blocked, id}`) — not at the next update.
  """
  alias Hoodride.{Chat, Requests, Rides}

  def apply(a, b) do
    for {rider, driver} <- [{a, b}, {b, a}] do
      case Requests.open_request_of(rider) do
        %{driver_id: ^driver} ->
          # the one who blocked asked: withdrawn; the other asked: declined
          if rider == a, do: Requests.cancel(rider), else: Requests.decline(driver, rider)

        _ ->
          :ok
      end
    end

    if Rides.partners?(a, b) do
      case Rides.ride_id_of_user(a) do
        ride when is_binary(ride) -> Rides.end_ride(ride, a)
        _ -> :ok
      end
    end

    Chat.delete_conversation(Chat.pair_key(a, b), :neutral)

    for {me, other} <- [{a, b}, {b, a}],
        {pid, _transport} <- Registry.lookup(Hoodride.WorldChannels, me),
        do: send(pid, {:blocked, other})

    :ok
  end

  @doc """
  Unblocked: each one's map shows the other again at once, if they're in
  view — a parked car sends no update of its own (the block journey,
  2026-11-15: it never came back).
  """
  def unblocked(a, b) do
    for {me, other} <- [{a, b}, {b, a}],
        {pid, _transport} <- Registry.lookup(Hoodride.WorldChannels, me),
        do: send(pid, {:unblocked, other})

    :ok
  end
end
