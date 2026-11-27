defmodule Hoodride.BlockEffects do
  @moduledoc """
  What a block ends, at once (owner, 2026-11-15) — called right after the
  block is saved (Hoodride.Blocks), so anything new between the two is
  already refused:

    1. a request between them, either way: withdrawn (the driver told it
       was cancelled, the rider's app quietly) or declined (the rider told it was declined) — as any
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
        %{driver_id: ^driver, ts: ts} ->
          # the one who blocked asked: withdrawn — THIS request (its stamp),
          # never a newer one to someone else; the other asked: declined
          if rider == a,
            do: withdrawn(rider, driver, ts),
            else: Requests.decline(driver, rider)

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

  # the rider's own request, withdrawn by their block: the driver's told
  # (request_cancelled, as any cancel) — and the rider's app too, quietly:
  # it kept "Waiting for the driver…" (every other chat greyed: "You
  # already requested a ride from" them) when the block's answer came too
  # late, or a reload caught the request before the block took it (review,
  # 2026-11-24). Their own app drops it on the block's answer as well.
  defp withdrawn(rider, driver, ts) do
    with :ok <- Requests.withdraw(rider, driver, ts) do
      HoodrideWeb.Endpoint.broadcast("user:#{rider}", "request_withdrawn", %{driver_id: driver})
    end
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
