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

  def start_link(opts) do
    every =
      Keyword.get(opts, :every_ms, Application.get_env(:hoodride, :sweep_every_ms, @every_ms))

    GenServer.start_link(__MODULE__, every, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(every), do: {:ok, schedule(every)}

  @impl true
  def handle_info(:sweep, %{every: every}) do
    sweep_now()
    {:noreply, schedule(every)}
  end

  # a shard's pause reply that landed after the recount gave up on it
  def handle_info({:held, _token, _shard}, state), do: {:noreply, state}

  # Every pass reads through Hoodride.ETS.each_match: the condition and the
  # projection run inside ETS, so a pass copies only the fields it uses of
  # the rows it acts on — a page at a time — never a whole table.
  import Hoodride.ETS, only: [each_match: 3]

  @hand_ids [{{:"$1", :_, :_}, [], [:"$1"]}]
  @driver_id_ts [{{:"$1", :_, :_, :"$2"}, [], [{{:"$1", :"$2"}}]}]
  # :pending seats belong to a ride still being set up — never "active"
  @active_seats [{{:"$1", :"$2"}, [{:"=/=", :"$2", :pending}], [{{:"$1", :"$2"}}]}]
  @request_pairs [{{:"$1", :"$2", :_}, [], [{{:"$1", :"$2"}}]}]
  @conversation_keys [{{:"$1", :_}, [], [:"$1"]}]

  @doc "One synchronous sweep — used by the timer and by tests."
  def sweep_now, do: run_steps(steps())

  @doc """
  The sweep's steps, in order — each {name, fun}. Run one by one by
  run_steps/1: a step that fails is logged and SKIPPED, never the ones after
  it (a step failing every time used to stop every later one for good —
  sign-ins, rate rows, chats piling up on a 1 GB server; the recount
  never running).
  """
  def steps do
    [
      {:expire_stale_requests, &expire_stale_requests/0},
      {:heal_orphan_ride_slots, &heal_orphan_ride_slots/0},
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
      # sign-outs past every session's lifetime revoke nothing any more
      {:sign_outs, &Hoodride.SignOuts.sweep/0},
      # sign-ins past their 30 days (or their year): gone from memory
      {:session_tokens, &Hoodride.SessionTokens.sweep/0},
      # session-stamp rows of accounts with no device connected for a day
      {:session_stamps, &Hoodride.SessionStamp.prune/0},
      # the recount trusts membership: repair it first
      {:rebuild_members,
       fn ->
         Enum.each(Hoodride.Geo.member_drift(), fn user_id ->
           repaired("membership drift")
           Hoodride.Geo.rebuild_members(user_id)
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
    # (a) car AND hand at once — the parents row is last-writer-wins, so its
    # role names the winner; the loser dies with full semantics (a losing
    # car declines its waiters)
    each_match(:geo_hands, @hand_ids, fn user_id ->
      if Hoodride.Geo.driver_on_map?(user_id) do
        repaired("car and ✋ at once")

        case :ets.lookup(:geo_parents, user_id) do
          [{_, :driver, _}] ->
            Hoodride.Geo.hand_down(user_id)

          [{_, :hand, _}] ->
            Hoodride.Geo.driver_offline(user_id)

          [] ->
            Hoodride.Geo.hand_down(user_id)
            Hoodride.Geo.driver_offline(user_id)
        end
      end
    end)

    # (b) mid-ride ghosts: a positional update that raced the ride start
    each_match(:rides_by_user, @active_seats, fn {user_id, _ride_id} ->
      car? = Hoodride.Geo.driver_on_map?(user_id)
      hand? = :ets.member(:geo_hands, user_id)
      if car? or hand?, do: repaired("on the map mid-ride")
      if car?, do: Hoodride.Geo.driver_offline(user_id)
      if hand?, do: Hoodride.Geo.hand_down(user_id)
    end)

    # (altitude orphans are pruned by the recount, inside its writer pause)

    # (c) cell index drift — a read-only scan finds suspect users, then each
    # is re-derived inside its OWN writer shard (serialized with its live
    # updates, so a false positive from an in-flight write is harmless)
    Enum.each(Hoodride.Geo.cell_index_drift(), fn user_id ->
      repaired("cell index drift")
      Hoodride.Geo.reindex_user(user_id)
    end)
  end

  # The request reconciler: a create can race the thing that would have
  # refused it (its rider's own ride start, its driver going busy/offline).
  # Resolution reuses the normal paths, so everyone gets the normal notice.
  @doc false
  def heal_unlawful_requests do
    # "has a seat" is a yes/no question: member/2 answers it without copying
    # the seat row (same meaning as ride_id_of_user(id) != nil)
    each_match(:ride_requests, @request_pairs, fn {rider_id, driver_id} ->
      cond do
        :ets.member(:rides_by_user, rider_id) ->
          repaired("unlawful request")
          Hoodride.Requests.cancel(rider_id)

        :ets.member(:rides_by_user, driver_id) or not Hoodride.Geo.driver_on_map?(driver_id) ->
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

  defp schedule(:manual), do: %{every: :manual, timer: nil}
  defp schedule(ms), do: %{every: ms, timer: Process.send_after(self(), :sweep, ms)}

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
    now = System.system_time(:second)

    # every driver needs the grace check (presence lives outside the row),
    # so this pass reads them all — but copies only {id, ts}, never the
    # cell or spot
    each_match(:geo_drivers, @driver_id_ts, fn {user_id, ts} ->
      stale? = now - ts > @position_stale

      if stale? or past_grace?(user_id, now) do
        # silent past the limit while CONNECTED: a stuck app (a repair);
        # silent because they left: the normal grace reap
        if stale? and Hoodride.Geo.connected?(user_id), do: repaired("frozen car")
        Hoodride.Geo.driver_offline(user_id)
      end
    end)

    each_match(:geo_hands, @hand_ids, fn user_id ->
      if past_grace?(user_id, now), do: Hoodride.Geo.hand_down(user_id)
    end)
  end

  # A conversation lives while BOTH people are around. Deleting it tells
  # both (Chat.delete_conversation), so whoever is still in the app clears it.
  @doc false
  def sweep_empty_room_chats do
    now = System.system_time(:second)

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
