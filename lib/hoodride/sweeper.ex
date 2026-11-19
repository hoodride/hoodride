defmodule Hoodride.Sweeper do
  @moduledoc """
  The janitor. Wakes every minute, enforces every time-based death rule, sleeps.
  Naive full scan by design — unbeatable at neighborhood scale, upgrade path
  (deadline index) documented in ARCHITECTURE.md for when it's ever needed.
  """
  use GenServer
  require Logger

  # how often it wakes; config :sweep_every_ms — :manual in tests, which run
  # sweep_now/0 on purpose (a tick landing mid-test reaped that test's
  # presence-less drivers: random failures on a slow machine)
  @every_ms 60_000
  @request_ttl div(Hoodride.Limits.request_expiry_ms(), 1000)
  @presence_grace div(Hoodride.Limits.presence_grace_ms(), 1000)
  # the longest the pass waits on a map writer (a ride's start waits as long:
  # :ride_geo_timeout)
  @writer_wait 1_000
  # how far the wall clock may move apart from the steady one between two
  # passes before it counts as a jump
  @clock_skew_s 30
  # the steps that judge by the wall clock — skipped in a pass after it
  # jumped (handle_info :sweep). Only times that come from outside this
  # running server stay on it: a sign-in's (stored, and in the database)
  # and a sign-in state's (in the browser's cookie). Cars, ✋, presence,
  # requests and chats are aged by the STEADY clock since 2026-11-18 — a
  # skipped pass only helped a forward jump; a step BACK kept departed cars
  # and requests for as long as the step (ClockJumpTest)
  @timed_steps [
    :sign_in_states,
    :session_tokens
  ]

  def start_link(opts) do
    every =
      Keyword.get(opts, :every_ms, Application.get_env(:hoodride, :sweep_every_ms, @every_ms))

    GenServer.start_link(__MODULE__, every, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(every), do: {:ok, schedule(every)}

  @impl true
  def handle_info(:sweep, %{every: every} = state) do
    now = clock()
    jump = clock_jump_s(state.clock, now)

    if jump > @clock_skew_s do
      Logger.warning(
        "clock jumped #{jump} s since the last pass — its time-based cleanup skipped"
      )

      Hoodride.GeoWriter.short_waits(@writer_wait, fn -> run_steps(steps(skip_timed: true)) end)
    else
      sweep_now()
    end

    {:noreply, %{schedule(every) | clock: now}}
  end

  # a shard's pause reply that landed after the recount gave up on it
  def handle_info({:held, _token, _shard}, state), do: {:noreply, state}

  # anything else (nothing known sends one): ignored — a crash here would
  # restart the cleanup and lose its schedule (crash hardening, 2026-11-13)
  def handle_info(_other, state), do: {:noreply, state}

  # Every pass reads through Hoodride.ETS.each_match: the condition and the
  # projection run inside ETS, so a pass copies only the fields it uses of
  # the rows it acts on — a page at a time — never a whole table.
  import Hoodride.ETS, only: [each_match: 3]

  @hand_ids [{{:"$1", :_, :_}, [], [:"$1"]}]
  @driver_id_ts [{{:"$1", :_, :_, :"$2"}, [], [{{:"$1", :"$2"}}]}]
  # {:pending, starter, rider, driver} seats belong to a ride still being
  # set up — never "active" (a started ride's seat is its id, a string)
  @active_seats [{{:"$1", :"$2"}, [{:is_binary, :"$2"}], [{{:"$1", :"$2"}}]}]
  @starting_seats [{{:"$1", {:pending, :_, :_, :_}}, [], [:"$_"]}]
  # presence rows of people gone (not connected) — the grace ones
  @grace_rows [{{:"$1", :grace, :"$2"}, [], [{{:"$1", :"$2"}}]}]
  @online_rows [{{:"$1", :online, :_}, [], [:"$1"]}]
  @request_pairs [{{:"$1", :"$2", :_}, [], [{{:"$1", :"$2"}}]}]
  @conversation_keys [{{:"$1", :_}, [], [:"$1"]}]

  @doc """
  One synchronous sweep — used by the timer and by tests. Its map-writer
  waits are short (#{@writer_wait} ms, then none once one runs out:
  Hoodride.GeoWriter.short_waits/2) — waiting 5 s on each stale car with
  the writers backed up stalled every later step for minutes.
  """
  def sweep_now, do: Hoodride.GeoWriter.short_waits(@writer_wait, fn -> run_steps(steps()) end)

  @doc """
  The sweep's steps, in order — each {name, fun}. Run one by one by
  run_steps/1: a step that fails is logged and SKIPPED, never the ones after
  it (a step failing every time used to stop every later one for good —
  sign-ins, rate rows, chats piling up on a 1 GB server; the recount
  never running).
  """
  def steps(opts \\ []) do
    if opts[:skip_timed],
      do: Enum.reject(all_steps(), fn {name, _} -> name in @timed_steps end),
      else: all_steps()
  end

  defp all_steps do
    [
      {:expire_stale_requests, &expire_stale_requests/0},
      {:heal_orphan_ride_slots, &heal_orphan_ride_slots/0},
      {:heal_stranded_starting_seats, &heal_stranded_starting_seats/0},
      {:sweep_stale_geo, &sweep_stale_geo/0},
      {:heal_geo_consistency, &heal_geo_consistency/0},
      {:heal_unlawful_requests, &heal_unlawful_requests/0},
      {:requests_heal_index, fn -> Hoodride.Requests.heal_index(@request_ttl) end},
      {:sweep_empty_room_chats, &sweep_empty_room_chats/0},
      {:chat_heal_index, &Hoodride.Chat.heal_index/0},
      # message ids kept for retries: 10 minutes
      {:chat_sent_ids, &Hoodride.Chat.sweep_sent_ids/0},
      # full allowances are the same as none: drop their rows
      {:rate_budget, &Hoodride.RateBudget.sweep/0},
      # lifted sign-in blocks and finished failure windows
      {:sign_in_failures, &Hoodride.SignInFailures.sweep/0},
      # sign-in states past their 15 minutes
      {:sign_in_states, &Hoodride.SignInStates.sweep/0},
      # sign-ins past their 30 days (or their year): gone from memory
      {:session_tokens, &Hoodride.SessionTokens.sweep/0},
      # blocks of people away a while: out of memory (read again when needed)
      {:blocks, fn -> Hoodride.Blocks.sweep() end},
      # session-stamp rows of accounts with no device connected for a day
      {:session_stamps, &Hoodride.SessionStamp.prune/0},
      # presence rows of people gone past grace: no row already means "long
      # gone" — after every step above that reads them
      {:presence, &prune_presence/0},
      # the recount trusts membership: repair it first
      {:rebuild_members,
       fn ->
         Enum.each(Hoodride.Geo.member_strays(), fn {user_id, seen} ->
           repaired("membership drift")
           Hoodride.Geo.rebuild_members(user_id, seen)
         end)
       end},
      {:recompute_aggregates, &Hoodride.Geo.recompute_aggregates/0}
    ]
  end

  @doc false
  # each step on its own: anything it raises, throws or exits with is logged
  # (ONE line: "sweep step NAME failed: …") and the next step runs
  def run_steps(steps) do
    for {name, fun} <- steps do
      try do
        fun.()
      rescue
        e ->
          Logger.error(
            "sweep step #{name} failed: #{inspect(e.__struct__)} at #{place(__STACKTRACE__)}"
          )
      catch
        kind, _reason ->
          Logger.error("sweep step #{name} failed: #{kind} at #{place(__STACKTRACE__)}")
      end
    end

    log_repairs()
  end

  # where it failed: module, function/arity, file:line — never the error's
  # text or a call's arguments (they can carry a user id, a cell: a place)
  defp place([{mod, fun, args, loc} | _]) do
    arity = if is_list(args), do: length(args), else: args
    "#{inspect(mod)}.#{fun}/#{arity} #{loc[:file]}:#{loc[:line]}"
  end

  defp place(_), do: "?"

  # The REPAIR LOG: a repair is a fix of something that should never be (a
  # car and a ✋ at once, a seat with no ride, a drifted index…) — each kind
  # counted during the sweep, ONE warning line per kind after it ("repair:
  # WHAT ×N"). A non-empty repair log means a bug somewhere. Normal
  # clean-ups (someone gone past grace) are not repairs.
  defp repaired(what), do: Process.put({:repair, what}, Process.get({:repair, what}, 0) + 1)

  # a re-checked removal (Geo.reap): logged only when it removed something —
  # not when its re-check found the person had moved on (else a busy server
  # logged false repairs: the seventh review). Its answer not known in time
  # (the writer busy past the pass's wait): not logged — under, never over
  defp repaired_if(:removed, what), do: repaired(what)
  defp repaired_if(_kept_or_late, _what), do: :ok

  defp log_repairs do
    for {{:repair, what} = key, n} <- Process.get() do
      Process.delete(key)
      Logger.warning("repair: #{what} ×#{n}")
    end

    :ok
  end

  # The geo reconciler: single-process checks can't span tables atomically,
  # so parallel same-account mutations (two tabs) can leave race residue.
  # Every geo invariant gets healed within one tick.
  @doc false
  def heal_geo_consistency do
    # Each removal below is Geo.reap: its reason is asked AGAIN when the
    # removal runs in the writer — it may wait in a busy writer's queue
    # behind the person's own newer change (a ✋ just raised, a ride just
    # ended), and acting on the old look removed what they'd just done,
    # nothing telling them (independent review, 2026-11-18; SweeperStallTest)
    #
    # (a) car AND hand at once — the parents row is last-writer-wins, so its
    # role names the winner; the loser dies with full semantics (a losing
    # car declines its waiters)
    each_match(:geo_hands, @hand_ids, fn user_id ->
      if Hoodride.Geo.driver_on_map?(user_id) do
        role = parents_role(user_id)
        still = fn -> both_on_map?(user_id) and parents_role(user_id) == role end

        result =
          case role do
            :driver ->
              Hoodride.Geo.reap(:hand, user_id, still)

            :hand ->
              Hoodride.Geo.reap(:driver, user_id, still)

            # neither can be trusted: both go, in ONE step under one re-check
            # (two steps: the car's check couldn't tell its own ✋ removal
            # from the person lowering it — the sixth review)
            nil ->
              Hoodride.Geo.reap(:both, user_id, still)
          end

        repaired_if(result, "car and ✋ at once")
      end
    end)

    # (b) mid-ride ghosts: a positional update that raced the ride start
    each_match(:rides_by_user, @active_seats, fn {user_id, _ride_id} ->
      car? = Hoodride.Geo.driver_on_map?(user_id)
      hand? = :ets.member(:geo_hands, user_id)
      mid_ride = fn -> in_ride?(user_id) end
      car = if car?, do: Hoodride.Geo.reap(:driver, user_id, mid_ride)
      hand = if hand?, do: Hoodride.Geo.reap(:hand, user_id, mid_ride)
      if :removed in [car, hand], do: repaired("on the map mid-ride")
    end)

    # (altitude orphans are pruned by the recount, inside its writer pause)

    # (c) cell index drift — a read-only scan finds suspect users, then each
    # is re-derived inside its OWN writer shard (serialized with its live
    # updates, so a false positive from an in-flight write is harmless)
    Enum.each(Hoodride.Geo.cell_index_strays(), fn {user_id, seen} ->
      repaired("cell index drift")
      Hoodride.Geo.reindex_user(user_id, seen)
    end)
  end

  defp parents_role(user_id) do
    case :ets.lookup(:geo_parents, user_id) do
      [{_, role, _}] -> role
      [] -> nil
    end
  end

  defp both_on_map?(user_id),
    do: Hoodride.Geo.driver_on_map?(user_id) and :ets.member(:geo_hands, user_id)

  # A seat claimed for a ride that's starting names the start's caller —
  # the accepting driver's connection ({:pending, starter, rider, driver}:
  # Hoodride.Rides.start_ride). The caller gone and no ride working on the
  # start (none started, or it died), nothing can finish it: freed, the
  # person told their role — and the rider told their request was declined
  # (the accept had taken it) — else both stayed "in a ride" with no ride
  # until a restart (independent reviews, 2026-11-18). A ride mid-start-up
  # finishes or cleans up by itself; the caller alive: never touched.
  @doc false
  def heal_stranded_starting_seats do
    each_match(:rides_by_user, @starting_seats, fn {user_id, {:pending, starter, rider, driver}} =
                                                     row ->
      # (no ride working on it either: one mid-start-up finishes or cleans
      # up by itself — freeing its seats then lost a good Accept: the fifth
      # review, 2026-11-18)
      if not Process.alive?(starter) and not Hoodride.Rides.Ride.starting_for?(starter) and
           :ets.select_delete(:rides_by_user, [{row, [], [true]}]) == 1 do
        repaired("seat left starting")
        Hoodride.Roles.changed(user_id)
        if user_id == rider, do: Hoodride.Rides.abandoned_start(rider, driver)
      end
    end)
  end

  # Presence rows of people gone past grace (2026-11-18, independent review:
  # one per person since the server started, never removed — no row
  # already means "long gone", so it's the same answer). The exact row: a
  # reconnect meanwhile wrote a new one, kept. After every step that reads
  # them (the reaps, chats, sign-ins, blocks). An "online" row with no
  # channel (one ended without its goodbye — a hard kill, the phone book
  # restarting) starts its grace now, as past_grace?/2 does for people with
  # a car, ✋ or chat — for everyone else it stayed forever (the second
  # review)
  @doc false
  def prune_presence do
    now = steady_now()

    each_match(:geo_presence, @grace_rows, fn {user_id, since} ->
      if now - since > @presence_grace and not Hoodride.Geo.connected?(user_id),
        do: :ets.delete_object(:geo_presence, {user_id, :grace, since})
    end)

    each_match(:geo_presence, @online_rows, fn user_id ->
      if not Hoodride.Geo.connected?(user_id) do
        repaired("online without a channel")
        Hoodride.Geo.user_disconnected(user_id)
      end
    end)
  end

  # ages of cars, ✋, presence and chats: the steady clock (Hoodride.Geo)
  defp steady_now, do: System.monotonic_time(:second)

  # The request reconciler: a create can race the thing that would have
  # refused it (its rider's own ride start, its driver going busy/offline).
  # Resolution reuses the normal paths, so everyone gets the normal notice.
  @doc false
  def heal_unlawful_requests do
    # in a REAL ride — not one still starting (:pending): its start can
    # still fail, and its own start-up withdraws what it must. Counted as a
    # ride, a pass in those milliseconds cancelled the person's other
    # request (their app went on showing it) or declined the riders waiting
    # on them, before a start that then failed (crash review 2026-11-14;
    # StartingRideHealTest)
    each_match(:ride_requests, @request_pairs, fn {rider_id, driver_id} ->
      cond do
        in_ride?(rider_id) ->
          repaired("unlawful request")
          Hoodride.Requests.cancel(rider_id)

        in_ride?(driver_id) or not Hoodride.Geo.driver_on_map?(driver_id) ->
          repaired("unlawful request")
          Hoodride.Requests.decline(driver_id, rider_id)

        true ->
          :ok
      end
    end)
  end

  # a brutally-killed ride process can't run terminate/2 — reclaim its seats,
  # and say "ended" once per ride (its two seats are two rows) so neither app
  # sits on a dead ride screen
  @doc false
  def heal_orphan_ride_slots do
    ended =
      Hoodride.ETS.fold_match(:rides_by_user, @active_seats, MapSet.new(), fn {user_id, ride_id},
                                                                              acc ->
        # its process gone — never "it didn't answer": a ride busy for 5 s
        # (a slow database) was taken for gone, both told "ended" mid-ride
        if Hoodride.Rides.alive?(ride_id) do
          acc
        else
          if :ets.select_delete(:rides_by_user, [{{user_id, ride_id}, [], [true]}]) == 1 do
            Hoodride.Roles.changed(user_id)
            MapSet.put(acc, ride_id)
          else
            acc
          end
        end
      end)

    for ride_id <- ended do
      repaired("orphaned ride")
      HoodrideWeb.Endpoint.broadcast("ride:" <> ride_id, "ended", %{by: nil, reason: "error"})
    end

    :ok
  end

  defp schedule(:manual), do: %{every: :manual, timer: nil, clock: clock()}

  defp schedule(ms),
    do: %{every: ms, timer: Process.send_after(self(), :sweep, ms), clock: clock()}

  # A JUMP of the wall clock (crash review 2026-11-14): cars, requests and
  # chats are aged by it, so when it steps — booting with a wrong clock that
  # time sync then corrects — every age jumps at once, and a pass took every
  # car off the map, expired every request, closed chats. The steady clock
  # never jumps: the wall clock's move since the last pass, less the steady
  # clock's, is the jump. Over @clock_skew_s, that pass skips its
  # time-based steps; live cars and rides refresh their times within
  # seconds, so the next pass judges by the new clock (ClockJumpTest).
  defp clock, do: {System.system_time(:second), System.monotonic_time(:second)}

  @doc false
  def clock_jump_s({wall0, mono0}, {wall1, mono1}), do: abs(wall1 - wall0 - (mono1 - mono0))

  @doc false
  def expire_stale_requests do
    Hoodride.Requests.expire_older_than(@request_ttl)
  end

  # drivers/hands whose owner is past grace vanish from the map — and so do
  # FROZEN drivers: position silent past @position_stale despite a live
  # socket (wedged app, dead GPS pipeline). Healthy clients heartbeat every
  # ~20s even parked, so minutes of silence can only mean broken. Hands are
  # one-shot by design (no stream), so only grace applies to them.
  @position_stale div(Hoodride.Limits.position_stale_ms(), 1000)

  @doc false
  def sweep_stale_geo do
    now = steady_now()

    # every driver needs the grace check (presence lives outside the row),
    # so this pass reads them all — but copies only {id, ts}, never the
    # cell or spot
    each_match(:geo_drivers, @driver_id_ts, fn {user_id, ts} ->
      stale? = now - ts > @position_stale

      cond do
        # silent past the limit while CONNECTED: a stuck app (a repair) —
        # unless its fresh position, queued ahead of this, landed first
        # (else its waiting riders were told "declined" by a driver who
        # declined no one — independent review, 2026-11-18)
        stale? and Hoodride.Geo.connected?(user_id) ->
          Hoodride.Geo.reap(:driver, user_id, fn -> still_silent?(user_id) end)
          |> repaired_if("frozen car")

        # silent because they left: the normal reap — unless they're back by
        # the time it runs (Geo.reap: it may wait in a busy writer's queue)
        stale? or past_grace?(user_id, now) ->
          Hoodride.Geo.reap(:driver, user_id, fn ->
            still_silent?(user_id) or gone_past_grace?(user_id)
          end)

        true ->
          :ok
      end
    end)

    each_match(:geo_hands, @hand_ids, fn user_id ->
      if past_grace?(user_id, now),
        do: Hoodride.Geo.reap(:hand, user_id, fn -> gone_past_grace?(user_id) end)
    end)
  end

  # Asked again inside the writer, when a removal runs: gone NOW — not
  # connected, and past the grace by their CURRENT presence row (they may
  # have come back and left again while the removal waited: a fresh grace —
  # independent review, 2026-11-18)
  defp gone_past_grace?(user_id) do
    not Hoodride.Geo.connected?(user_id) and
      case :ets.lookup(:geo_presence, user_id) do
        [] -> true
        [{_, :online, _}] -> false
        [{_, _, since}] -> steady_now() - since > @presence_grace
      end
  end

  # (asked inside the writer, when the frozen car's removal runs)
  defp still_silent?(user_id) do
    case :ets.lookup(:geo_drivers, user_id) do
      [{_, _, _, ts}] -> steady_now() - ts > @position_stale
      [] -> false
    end
  end

  # A conversation lives while BOTH people are around. Deleting it tells
  # both (Chat.delete_conversation), so whoever is still in the app clears it.
  @doc false
  def sweep_empty_room_chats do
    now = steady_now()

    each_match(:chat_conversations, @conversation_keys, fn {a, b} = key ->
      # HISTORY (until 2026-10-23): a conversation died only when BOTH were
      # gone past grace, with no open request and no shared ride — so a
      # message waiting for someone away was kept until they came back:
      #
      #   if past_grace?(a, now) and past_grace?(b, now) and
      #        not Hoodride.Requests.open_between?(a, b) and not ride_between?(a, b) do
      #
      # Changed (owner's call): it dies once EITHER has been gone past
      # grace, unless they share a ride — the same 5-minute rule that
      # already takes their car or hand off the map. Accepted trade-off: a
      # message sent to someone away 5+ minutes is lost with the chat.
      # No request guard: a request never outlives grace (a driver gone past
      # grace is reaped, and its requests declined, earlier in this same
      # sweep; a rider's request expires 5 minutes after it was sent, before
      # they can have been gone that long).
      if (past_grace?(a, now) or past_grace?(b, now)) and not ride_between?(a, b) do
        Hoodride.Chat.delete_conversation(key)
      end
    end)
  end

  defp in_ride?(user_id), do: is_binary(Hoodride.Rides.ride_id_of_user(user_id))

  defp ride_between?(a, b) do
    ride_a = Hoodride.Rides.ride_id_of_user(a)
    ride_a != nil and ride_a == Hoodride.Rides.ride_id_of_user(b)
  end

  # presence_of's meaning (online = a live channel; else the stored clock;
  # no row = long gone), minus its clock read and tuple — `now` is read once
  # per pass, not once per user
  defp past_grace?(user_id, now) do
    not Hoodride.Geo.connected?(user_id) and
      case :ets.lookup(:geo_presence, user_id) do
        [] ->
          true

        # ONLINE, yet in no channel: its channel ended without a goodbye —
        # e.g. the phone book (the UserChannels Registry) restarting took
        # every channel down with it; the apps rejoin within a second. The
        # row's time is when they CONNECTED, never "gone since": the grace
        # clock starts NOW (a sweep in that gap reaped everyone connected
        # over 5 min — cars, ✋, chats). Truly gone: reaped 5 min on.
        [{_, :online, _}] ->
          repaired("online without a channel")
          Hoodride.Geo.user_disconnected(user_id)
          false

        [{_, _, since}] ->
          now - since > @presence_grace
      end
  end
end
