defmodule Hoodride.Requests do
  require Logger

  @moduledoc """
  The request state machine. One open request per rider (it's the table key).
  Open states are held, terminal states are deleted — resolution leaves nothing.
  Precondition-checked transitions via atomic :ets.take — first action wins.
  """

  @requests :ride_requests
  # per-driver index: {{driver_id, rider_id}, ts}, ts = the request's own.
  # "Who is waiting on me" is a bound-prefix range read — O(log n + k) —
  # instead of a copy of every open request in town.
  #
  # The main table stays the single arbiter (its atomic take decides every
  # race); the index only answers "where to look", and every hit is
  # confirmed against the main table. A create writes its index row FIRST;
  # whoever consumes a request deletes exactly {{driver, rider}, ts} AFTER —
  # so a newer request between the same pair keeps its own row. The only
  # gap (a re-request inside the same second, which the 60 s cooldown makes
  # near-impossible) is re-indexed by the sweeper's heal_index.
  @by_driver :requests_by_driver

  # THE RIDER'S BLOCK (ARCHITECTURE.md "Distances"): a request shares the
  # rider's rough area — a ~170 m block — with that one driver.
  # {rider_id, driver_id, ts, spot, at_ms}, stamped with its request: it's
  # served ONLY while that same request (rider, driver, ts) is open, so every
  # way a request ends hides it at once; the repair pass removes the row.
  @spots :request_spots

  def init_tables do
    Hoodride.ETS.new(@requests, [:named_table, :public, :set])
    Hoodride.ETS.new(@by_driver, [:named_table, :public, :ordered_set])
    Hoodride.ETS.new(@spots, [:named_table, :public, :set])
    :ok
  end

  # a request left the main table for good — drop its own index row
  defp consumed(rider_id, driver_id, ts),
    do: :ets.delete_object(@by_driver, {{driver_id, rider_id}, ts})

  # `spot`: the rider's block, or nil — the caller decides whether it may be
  # shared (HoodrideWeb.UserChannel)
  def create(rider, driver_id, spot \\ nil) do
    cond do
      rider.id == driver_id -> {:error, :self}
      Hoodride.Rides.ride_id_of_user(rider.id) != nil -> {:error, :in_ride}
      Hoodride.Rides.ride_id_of_user(driver_id) != nil -> {:error, :driver_busy}
      # unavailable means unaskable too: no new requests toward an off-map
      # driver (they'd just sit out the TTL against someone who can't come)
      not Hoodride.Geo.driver_on_map?(driver_id) -> {:error, :driver_offline}
      true -> do_create(rider, driver_id, spot)
    end
  end

  defp do_create(rider, driver_id, spot) do
    now = System.system_time(:second)

    # index first: the request is findable the instant it exists
    :ets.insert(@by_driver, {{driver_id, rider.id}, now})

    cond do
      not :ets.insert_new(@requests, {rider.id, driver_id, now}) ->
        lost_create(rider, driver_id, now)

      # the driver went offline between the check and this save: withdraw
      # it at once, before telling them (Geo.offline_core declines again
      # after the car is off the map — together, nothing waits on an offline
      # driver for the 60 s repair)
      not Hoodride.Geo.driver_on_map?(driver_id) ->
        case take_if_ours(rider.id, driver_id) do
          {:ok, ts} -> consumed(rider.id, driver_id, ts)
          _ -> :ok
        end

        {:error, :driver_offline}

      true ->
        announce(rider, driver_id, now, spot)
    end
  end

  defp announce(rider, driver_id, now, spot) do
    if spot,
      do: :ets.insert(@spots, {rider.id, driver_id, now, spot, System.system_time(:millisecond)})

    HoodrideWeb.Endpoint.broadcast("user:#{driver_id}", "request", %{
      from: %{id: rider.id, name: rider.name, photo: rider.photo},
      spot: spot
    })

    :ok
  end

  # lost (a request already stands): undo our index row, or restore the
  # standing request's own ts if it targets the same driver (we just
  # overwrote it)
  defp lost_create(rider, driver_id, now) do
    case :ets.lookup(@requests, rider.id) do
      [{_, ^driver_id, ts}] -> :ets.insert(@by_driver, {{driver_id, rider.id}, ts})
      _ -> :ets.delete_object(@by_driver, {{driver_id, rider.id}, now})
    end

    {:error, :already_requested}
  end

  def cancel(rider_id) do
    case :ets.take(@requests, rider_id) do
      [{_, driver_id, ts}] ->
        consumed(rider_id, driver_id, ts)
        # no request -> cancel -> request loop popping up on the driver's screen
        Hoodride.Throttle.start_request_cooldown(rider_id, driver_id)

        HoodrideWeb.Endpoint.broadcast("user:#{driver_id}", "request_cancelled", %{
          from_id: rider_id
        })

        :ok

      [] ->
        {:error, :none}
    end
  end

  # Take the rider's request ONLY if it's this driver's — one atomic step.
  # It used to take any request, then put back one that wasn't theirs; in
  # that gap the rider's cancel found nothing (and the put-back revived the
  # cancelled request), or a new request filled the slot and the put-back
  # overwrote it — 151–192 lost cancels and 41–48 overwritten requests in
  # 300 truly parallel rounds (RequestsPutBackTest, 2026-10-29). Now another
  # driver's request is never touched: the exact row is deleted only if it
  # is still there (`select_delete`), else read again.
  # → {:ok, ts} | :not_yours | :none
  defp take_if_ours(rider_id, driver_id) do
    case :ets.lookup(@requests, rider_id) do
      [{^rider_id, ^driver_id, ts} = row] ->
        if :ets.select_delete(@requests, [{row, [], [true]}]) == 1,
          do: {:ok, ts},
          else: take_if_ours(rider_id, driver_id)

      [{^rider_id, _other_driver, _}] ->
        :not_yours

      [] ->
        :none
    end
  end

  def decline(driver_id, rider_id) do
    case take_if_ours(rider_id, driver_id) do
      {:ok, ts} ->
        consumed(rider_id, driver_id, ts)
        # "no" sticks for a full minute from the moment it's said
        Hoodride.Throttle.start_request_cooldown(rider_id, driver_id)

        HoodrideWeb.Endpoint.broadcast("user:#{rider_id}", "request_declined", %{by_id: driver_id})

        :ok

      :not_yours ->
        {:error, :not_yours}

      :none ->
        {:error, :none}
    end
  end

  def accept(driver, rider_id) do
    driver_id = driver.id

    case take_if_ours(rider_id, driver_id) do
      {:ok, ts} ->
        cond do
          Hoodride.Rides.ride_id_of_user(driver.id) != nil ->
            # driver already busy — busy means unavailable: decline, don't
            # reinsert (a put-back could race past decline_all and linger)
            consumed(rider_id, driver_id, ts)
            decline_consumed(rider_id, driver.id)
            {:error, :busy}

          Hoodride.Rides.ride_id_of_user(rider_id) != nil ->
            # rider got into another ride somehow — the request is stale, drop it
            consumed(rider_id, driver_id, ts)
            {:error, :gone}

          true ->
            case Hoodride.Rides.start_ride(rider_id, driver.id) do
              {:ok, ride_id} ->
                consumed(rider_id, driver_id, ts)
                {:ok, ride_id}

              {:error, :busy} ->
                # lost the seat-claim race on another socket — same rule: the
                # winner made someone busy, so this request dies with notice
                consumed(rider_id, driver_id, ts)
                decline_consumed(rider_id, driver.id)
                {:error, :busy}

              error ->
                # the ride couldn't start: the request stands again — but
                # only into an EMPTY slot (insert_new), never over a request
                # the rider made in the meantime
                :ets.insert_new(@requests, {rider_id, driver_id, ts})
                error
            end
        end

      :not_yours ->
        {:error, :not_yours}

      :none ->
        # cancelled or expired first — the race, resolved
        {:error, :gone}
    end
  end

  # the request is already consumed (taken) — tell the rider so they re-shop
  defp decline_consumed(rider_id, driver_id) do
    HoodrideWeb.Endpoint.broadcast("user:#{rider_id}", "request_declined", %{by_id: driver_id})
  end

  @doc """
  A driver who becomes unavailable — goes offline, is grace-reaped, or enters
  a ride — declines everyone still waiting on them, each rider notified
  instantly so they can re-shop. Same atomic take as a manual decline.
  """
  def decline_all_for_driver(driver_id) do
    for {{^driver_id, rider_id}, _ts} <- :ets.match_object(@by_driver, {{driver_id, :_}, :_}) do
      case take_if_ours(rider_id, driver_id) do
        {:ok, ts} ->
          consumed(rider_id, driver_id, ts)

          HoodrideWeb.Endpoint.broadcast("user:#{rider_id}", "request_declined", %{
            by_id: driver_id
          })

        # raced: the rider withdrew and re-asked someone else — not ours,
        # and never touched (no take-and-put-back)
        :not_yours ->
          :ok

        :none ->
          :ok
      end
    end

    :ok
  end

  def open_request_of(rider_id) do
    case :ets.lookup(@requests, rider_id) do
      [{_, driver_id, ts}] -> %{driver_id: driver_id, ts: ts}
      [] -> nil
    end
  end

  def pending_for_driver(driver_id) do
    for {{^driver_id, rider_id}, _} <- :ets.match_object(@by_driver, {{driver_id, :_}, :_}),
        [{^rider_id, ^driver_id, ts}] <- [:ets.lookup(@requests, rider_id)] do
      %{rider_id: rider_id, ts: ts, spot: spot_of(rider_id, driver_id, ts)}
    end
  end

  # the block sent with THIS request (same rider, driver and time), with its
  # age on the server's clock — or nil
  defp spot_of(rider_id, driver_id, ts) do
    case :ets.lookup(@spots, rider_id) do
      [{_, ^driver_id, ^ts, spot, at}] ->
        %{spot: spot, age_ms: max(System.system_time(:millisecond) - at, 0)}

      _ ->
        nil
    end
  end

  def open_between?(a, b) do
    case :ets.lookup(@requests, a) do
      [{_, ^b, _}] ->
        true

      _ ->
        case :ets.lookup(@requests, b) do
          [{_, ^a, _}] -> true
          _ -> false
        end
    end
  end

  @doc """
  Sweeper repair for the per-driver index, in one pass when healthy.

  It walks the index rows, checking each one's rider has an open request
  to that driver (a one-field hash lookup). Riders are the request table's
  key, so passing rows map to distinct requests. If they all pass and the
  index holds exactly as many rows as there are requests, every request
  has its row and nothing else runs.

  Otherwise it re-adds missing rows and drops rows matching no open
  request once they're older than `ttl` — younger ones may belong to a
  create still in flight (index written, main row not yet), and no live
  request outlives the TTL anyway. Reads in pages (Hoodride.ETS): nothing
  copies a whole table.
  """
  def heal_index(ttl) do
    import Hoodride.ETS, only: [each_match: 3, fold_match: 4]

    clean? =
      fold_match(@by_driver, [{{{:"$1", :"$2"}, :_}, [], [{{:"$1", :"$2"}}]}], true, fn
        {driver_id, rider_id}, ok ->
          ok and :ets.lookup_element(@requests, rider_id, 2, nil) == driver_id
      end)

    unless clean? and :ets.info(@by_driver, :size) == :ets.info(@requests, :size) do
      # (the repair log — Hoodride.Sweeper)
      Logger.warning("repair: request index ×1")

      each_match(@requests, [{:"$1", [], [:"$1"]}], fn {rider_id, driver_id, ts} ->
        unless :ets.member(@by_driver, {driver_id, rider_id}),
          do: :ets.insert(@by_driver, {{driver_id, rider_id}, ts})
      end)

      drop_stale_index(ttl)
    end

    # a block whose request is no longer open goes
    each_match(@spots, [{:"$1", [], [:"$1"]}], fn {rider_id, driver_id, ts, _, _} = row ->
      unless match?([{_, ^driver_id, ^ts}], :ets.lookup(@requests, rider_id)),
        do: :ets.delete_object(@spots, row)
    end)

    :ok
  end

  defp drop_stale_index(ttl) do
    import Hoodride.ETS, only: [fold_match: 4]
    cutoff = System.system_time(:second) - ttl

    # the age test runs inside ETS: only rows old enough to be stale are
    # copied out and checked against the main table
    stale =
      fold_match(@by_driver, [{{:_, :"$1"}, [{:<, :"$1", cutoff}], [:"$_"]}], [], fn
        {{driver_id, rider_id}, _ts} = row, acc ->
          if match?([{_, ^driver_id, _}], :ets.lookup(@requests, rider_id)),
            do: acc,
            else: [row | acc]
      end)

    Enum.each(stale, &:ets.delete_object(@by_driver, &1))
  end

  def expire_older_than(seconds) do
    cutoff = System.system_time(:second) - seconds

    # the age test runs inside ETS: only expired requests are copied out
    Hoodride.ETS.each_match(@requests, [{{:_, :_, :"$1"}, [{:<, :"$1", cutoff}], [:"$_"]}], fn
      {rider_id, driver_id, ts} = row ->
        # exact-row delete: only THIS old request dies, never a fresh
        # re-request the same rider made since the page was read
        if :ets.select_delete(@requests, [{row, [], [true]}]) == 1 do
          consumed(rider_id, driver_id, ts)
          HoodrideWeb.Endpoint.broadcast("user:#{rider_id}", "request_expired", %{})

          HoodrideWeb.Endpoint.broadcast("user:#{driver_id}", "request_expired_driver", %{
            from_id: rider_id
          })
        end
    end)
  end
end
