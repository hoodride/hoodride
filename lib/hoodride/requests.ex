defmodule Hoodride.Requests do
  require Logger

  @moduledoc """
  The request state machine. One open request per rider (it's the table key).
  Open states are held, terminal states are deleted — resolution leaves nothing.
  Precondition-checked transitions via atomic :ets.take — first action wins.
  """

  @requests :ride_requests
  # an Accept at work on a rider's request ({rider_id, its pid}): a Cancel
  # that finds no request waits for it (accepting/1)
  @accepting :ride_requests_accepting
  # a rider's Cancel that gave up waiting for the Accepts still at work: each
  # of THOSE Accepts, failing, cancels the request instead of putting it
  # back ({rider_id, work} — work: {pid, ref}, ONE Accept's, never reused:
  # a mark the rider's alone was wiped by any other Accept on them; one the
  # accepting process's (a driver's connection, which lives on) cancelled
  # its later Accept's request — reviews, 2026-11-20; cancel_by_rider/1,
  # accept/3). @accepting holds the same: {rider_id, work}
  @cancel_wanted :ride_requests_cancel_wanted
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
    Hoodride.ETS.new(@accepting, [:named_table, :public, :bag])
    Hoodride.ETS.new(@cancel_wanted, [:named_table, :public, :bag])
    Hoodride.ETS.new(@by_driver, [:named_table, :public, :ordered_set])
    Hoodride.ETS.new(@spots, [:named_table, :public, :set])
    :ok
  end

  # a request left the main table for good — drop its own index row
  defp consumed(rider_id, driver_id, ts),
    do: :ets.delete_object(@by_driver, {{driver_id, rider_id}, ts})

  # `spot`: the rider's block, or nil — the caller decides whether it may be
  # shared (HoodrideWeb.UserChannel)
  def create(rider, driver_id, spot \\ nil, still_signed_in \\ fn -> true end) do
    cond do
      rider.id == driver_id -> {:error, :self}
      Hoodride.Rides.ride_id_of_user(rider.id) != nil -> {:error, :in_ride}
      Hoodride.Rides.ride_id_of_user(driver_id) != nil -> {:error, :driver_busy}
      # unavailable means unaskable too: no new requests toward an off-map
      # driver (they'd just sit out the TTL against someone who can't come)
      not Hoodride.Geo.driver_on_map?(driver_id) -> {:error, :driver_offline}
      true -> do_create(rider, driver_id, spot, still_signed_in)
    end
  end

  defp do_create(rider, driver_id, spot, still_signed_in) do
    # a request's age is a length of time: the steady clock (wall_ts/1 for
    # anything shown — ClockJumpTest, 2026-11-18)
    now = steady_s()

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

      # saved — THEN: still signed in? Signed out since the channel's
      # check, the sign-out may have looked for a request before this (A1,
      # Rides.after_sign_out): withdrawn, never shown
      not still_signed_in.() ->
        case take_if_ours(rider.id, driver_id) do
          {:ok, ts} -> consumed(rider.id, driver_id, ts)
          _ -> :ok
        end

        {:error, :signed_out}

      true ->
        announce(rider, driver_id, now, spot)
    end
  end

  defp announce(rider, driver_id, now, spot) do
    if spot,
      do:
        :ets.insert(@spots, {rider.id, driver_id, now, spot, System.monotonic_time(:millisecond)})

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

  # (tests only: env :requests_hook — a pause, or an answer given; nil: none)
  defp hook(step) do
    if f = Application.get_env(:hoodride, :requests_hook), do: f.(step)
  end

  # how long a Cancel waits for an Accept at work (a few microseconds, or a
  # ride starting: well under this; tests shorten it: env :accept_wait_ms)
  @accept_wait_ms 5_000

  @doc """
  The rider's OWN Cancel (the app's button — HoodrideWeb.UserChannel): as
  cancel/1, but finding nothing while an Accept is at work on it, waits for
  that Accept, then looks again — a ride now: the caller says "accepted";
  put back: cancelled after all; still at work after the wait,
  `{:error, :accepting}`. Never used by the server's own cancels (a
  ride starting cancels its people's other asks — waiting there for the
  Accept that is starting it would wait for itself).
  """
  def cancel_by_rider(rider_id) do
    case take_to_cancel(rider_id) do
      :none ->
        if accepting?(rider_id) do
          wait = Application.get_env(:hoodride, :accept_wait_ms, @accept_wait_ms)
          wait_accepting(rider_id, System.monotonic_time(:millisecond) + wait)

          # still at work when the wait ran out (a stalled database): not
          # "cancelled" — the ride may start any moment (the app waits for
          # it, else asks the server what's true)
          if accepting?(rider_id),
            do: leave_cancel(rider_id),
            else: take_to_cancel(rider_id) |> cancelled(rider_id)
        else
          {:error, :none}
        end

      found ->
        cancelled(found, rider_id)
    end
  end

  # The Cancel left with the Accepts at work now: each, failing, cancels
  # instead of putting the request back. The marks first, THEN the request
  # looked for again — one put back before they were there is here now
  # (taken: cancelled); one put back after, its Accept sees its mark. Marks
  # of Accepts no longer at work are dropped, then looked once more: one put
  # back by an Accept that ended meanwhile is here by then (it puts back
  # BEFORE it stops counting as at work) — its mark taken by it, or dropped
  # here: one or the other, never neither.
  defp leave_cancel(rider_id) do
    drop_done_marks(rider_id)
    marks = for {_, work} <- :ets.lookup(@accepting, rider_id), do: {rider_id, work}
    # (tests: a pause before the marks, and after the look again)
    hook(:marking)
    :ets.insert(@cancel_wanted, marks)

    case take_to_cancel(rider_id) do
      :none ->
        hook(:relooked)
        at_work = Enum.any?(marks, fn {_, work} -> at_work?(rider_id, work) end)
        drop_done_marks(rider_id)

        case take_to_cancel(rider_id) do
          # still at work: "accepted" (the ride may start); all done: a ride
          # (the caller says "accepted"), or the request ended (declined, or
          # cancelled by its mark)
          :none -> if at_work, do: {:error, :accepting}, else: {:error, :none}
          found -> cancelled(found, rider_id)
        end

      found ->
        drop_done_marks(rider_id)
        cancelled(found, rider_id)
    end
  end

  # (killed Accepts' too — their clean-up never ran)
  defp drop_done_marks(rider_id) do
    for {_, work} = mark <- :ets.lookup(@cancel_wanted, rider_id),
        not at_work?(rider_id, work),
        do: :ets.delete_object(@cancel_wanted, mark)
  end

  defp at_work?(rider_id, {pid, _} = work),
    do: Process.alive?(pid) and :ets.match_object(@accepting, {rider_id, work}) != []

  @doc "The rider's request withdrawn now (the driver told): `:ok` or `{:error, :none}`."
  def cancel(rider_id), do: take_to_cancel(rider_id) |> cancelled(rider_id)

  defp take_to_cancel(rider_id) do
    case :ets.take(@requests, rider_id) do
      [row] -> row
      [] -> :none
    end
  end

  # an Accept at work on this rider's request (its process alive)
  defp accepting?(rider_id),
    do: Enum.any?(:ets.lookup(@accepting, rider_id), fn {_, {pid, _}} -> Process.alive?(pid) end)

  defp wait_accepting(rider_id, deadline) do
    if accepting?(rider_id) and System.monotonic_time(:millisecond) < deadline do
      Process.sleep(1)
      wait_accepting(rider_id, deadline)
    end
  end

  defp cancelled(:none, _rider_id), do: {:error, :none}

  defp cancelled({_, driver_id, ts}, rider_id) do
    consumed(rider_id, driver_id, ts)
    # no request -> cancel -> request loop popping up on the driver's screen
    Hoodride.Throttle.start_request_cooldown(rider_id, driver_id)

    HoodrideWeb.Endpoint.broadcast("user:#{driver_id}", "request_cancelled", %{
      from_id: rider_id
    })

    :ok
  end

  # this very request (rider, driver, ts) cancelled, if it's still there —
  # never a newer one the rider made since
  defp cancel_exact(rider_id, driver_id, ts) do
    if :ets.select_delete(@requests, [{{rider_id, driver_id, ts}, [], [true]}]) == 1,
      do: cancelled({rider_id, driver_id, ts}, rider_id)
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
  # the ride's look (accept/3): the accepting connection, and the rider —
  # any sign-in left (a sign-out or a deletion removes every one BEFORE it
  # looks for a ride: Rides.after_sign_out)
  # (and no block either way since the request: a block made in the moment
  # of the accept — Hoodride.BlockEffects ends what it can see, this the rest)
  defp ride_look(nil, rider_id, driver_id),
    do: fn -> not Hoodride.Blocks.blocked?(driver_id, rider_id) end

  defp ride_look(still_signed_in, rider_id, driver_id),
    do: fn ->
      still_signed_in.() and Hoodride.SessionTokens.any?(rider_id) and
        not Hoodride.Blocks.blocked?(driver_id, rider_id)
    end

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

  @doc """
  The driver accepts the rider's request: `{:ok, ride_id}` or an error.
  `still_signed_in` — the accepting connection's own sign-in check (the
  channel's) — makes the ride look once its seats are its own (A1): that
  connection still signed in AND the rider still signed in anywhere (their
  sign-out deletes every sign-in, THEN looks for a ride: whichever is second
  sees the other). nil (the default: tests, server tools): no look.
  """
  # The Accept TAKES the request, then claims the seats: a Cancel in between
  # found neither — "ok", "Request cancelled", then the ride opened; and if
  # the ride couldn't start the request was put back after the Cancel had
  # answered — the Cancel lost (the 2026-11-08 server review's note, still
  # open until 2026-11-20). Now the Accept leaves a mark while it works; a
  # Cancel finding nothing but the mark waits for it, then answers by what
  # it did (cancel/1)
  def accept(driver, rider_id, still_signed_in \\ nil) do
    work = {self(), make_ref()}
    :ets.insert(@accepting, {rider_id, work})
    # (tests: a pause with the Accept marked at work, nothing taken yet)
    hook(:accepting)

    try do
      accept_marked(driver, rider_id, still_signed_in, work)
    after
      :ets.delete_object(@accepting, {rider_id, work})
      # (a Cancel left with THIS Accept: done with — another's untouched)
      :ets.delete_object(@cancel_wanted, {rider_id, work})
    end
  end

  defp accept_marked(driver, rider_id, still_signed_in, work) do
    driver_id = driver.id
    look = ride_look(still_signed_in, rider_id, driver_id)

    case take_if_ours(rider_id, driver_id) do
      {:ok, ts} ->
        # (tests: a pause between the take and the seats)
        hook(:taken)

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
            # (tests: a ride start's answer given instead)
            started = hook(:start) || Hoodride.Rides.start_ride(rider_id, driver.id, look)

            case started do
              {:ok, ride_id} ->
                consumed(rider_id, driver_id, ts)
                {:ok, ride_id}

              {:error, :busy} ->
                # lost the seat-claim race on another socket — same rule: the
                # winner made someone busy, so this request dies with notice
                consumed(rider_id, driver_id, ts)
                decline_consumed(rider_id, driver.id)
                {:error, :busy}

              {:error, reason} when reason in [:signed_out, :no_such_user] ->
                # one of them signed out meanwhile, or the rider's account
                # is gone (A1): the request ends here — declined, as for a
                # busy driver — never put back for someone no longer there
                consumed(rider_id, driver_id, ts)
                decline_consumed(rider_id, driver.id)
                {:error, reason}

              error ->
                # the ride couldn't start: the request stands again — but
                # only into an EMPTY slot (insert_new), never over a request
                # the rider made in the meantime
                :ets.insert_new(@requests, {rider_id, driver_id, ts})

                # put back — THEN: the rider's Cancel, given up waiting for
                # this, left with it? Cancelled now (the mark looked at only
                # once this Accept no longer counts as at work: a Cancel
                # that saw it at work had marked first)
                :ets.delete_object(@accepting, {rider_id, work})
                # (tests: a pause here — no longer at work, its mark not looked at)
                hook(:done_working)

                # (taken in one step: it, or the Cancel's drop — never both)
                if :ets.select_delete(@cancel_wanted, [{{rider_id, work}, [], [true]}]) == 1,
                  do: cancel_exact(rider_id, driver_id, ts)

                # …and: either of them signed out meanwhile (their
                # sign-out may have looked for a request before this — A1)?
                # Taken back: declined, never left for someone gone
                unless look.() do
                  case take_if_ours(rider_id, driver_id) do
                    {:ok, back} ->
                      consumed(rider_id, driver_id, back)
                      decline_consumed(rider_id, driver_id)

                    _ ->
                      :ok
                  end
                end

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

  @doc "A request already taken, told to its rider as declined (Rides.abandoned_start/2)."
  def declined_by(rider_id, driver_id) do
    taken(rider_id, driver_id)
    decline_consumed(rider_id, driver_id)
  end

  @doc """
  A request an Accept took, its own clean-up never reached (the accepting
  connection gone mid-start): its index row goes — unless the rider has
  asked this driver again since (then the row is that request's). Left, the
  index repair called it a bug for 5 minutes (the third and fourth reviews,
  2026-11-18).
  """
  def taken(rider_id, driver_id) do
    unless match?([{_, ^driver_id, _}], :ets.lookup(@requests, rider_id)),
      do: :ets.delete(@by_driver, {driver_id, rider_id})

    :ok
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
        %{spot: spot, age_ms: max(System.monotonic_time(:millisecond) - at, 0)}

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
    cutoff = steady_s() - ttl

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
    cutoff = steady_s() - seconds

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

  defp steady_s, do: System.monotonic_time(:second)

  @doc """
  A request's time (the steady clock) as the wall clock's seconds — for
  anything sent out (/api/state). Its age is exact even across a jump.
  """
  def wall_ts(ts), do: System.system_time(:second) - (steady_s() - ts)
end
