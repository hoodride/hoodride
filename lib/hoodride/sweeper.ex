defmodule Hoodride.Sweeper do
  @moduledoc """
  The janitor. Wakes every minute, enforces every time-based death rule, sleeps.
  Naive full scan by design — unbeatable at neighborhood scale, upgrade path
  (deadline index) documented in ARCHITECTURE.md for when it's ever needed.
  """
  use GenServer

  # how often it wakes; config :sweep_every_ms — :manual in tests, which run
  # sweep_now/0 on purpose (a tick landing mid-test reaped that test's
  # presence-less drivers: random failures on a slow machine)
  @every_ms 60_000
  @request_ttl 5 * 60
  @presence_grace 5 * 60

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
  def sweep_now do
    expire_stale_requests()
    heal_orphan_ride_slots()
    sweep_stale_geo()
    heal_geo_consistency()
    heal_unlawful_requests()
    Hoodride.Requests.heal_index(@request_ttl)
    sweep_empty_room_chats()
    Hoodride.Chat.heal_index()
    # full allowances are the same as none: drop their rows
    Hoodride.RateBudget.sweep()
    # lifted sign-in blocks and finished failure windows
    Hoodride.SignInFailures.sweep()
    # sign-outs past every session's lifetime revoke nothing any more
    Hoodride.SignOuts.sweep()
    # sign-ins past their 30 days (or their year): gone from memory
    Hoodride.SessionTokens.sweep()
    # session-stamp rows of accounts with no device connected for a day
    Hoodride.SessionStamp.prune()
    # the recount trusts membership: repair it first
    Enum.each(Hoodride.Geo.member_drift(), &Hoodride.Geo.rebuild_members/1)
    Hoodride.Geo.recompute_aggregates()
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
      if Hoodride.Geo.driver_on_map?(user_id), do: Hoodride.Geo.driver_offline(user_id)
      if :ets.member(:geo_hands, user_id), do: Hoodride.Geo.hand_down(user_id)
    end)

    # (altitude orphans are pruned by the recount, inside its writer pause)

    # (c) cell index drift — a read-only scan finds suspect users, then each
    # is re-derived inside its OWN writer shard (serialized with its live
    # updates, so a false positive from an in-flight write is harmless)
    Enum.each(Hoodride.Geo.cell_index_drift(), &Hoodride.Geo.reindex_user/1)
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
          Hoodride.Requests.cancel(rider_id)

        :ets.member(:rides_by_user, driver_id) or not Hoodride.Geo.driver_on_map?(driver_id) ->
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
        case Hoodride.Rides.get(ride_id) do
          {:error, :gone} ->
            if :ets.select_delete(:rides_by_user, [{{user_id, ride_id}, [], [true]}]) == 1 do
              Hoodride.Roles.changed(user_id)
              MapSet.put(acc, ride_id)
            else
              acc
            end

          _ ->
            acc
        end
      end)

    for ride_id <- ended do
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
  @position_stale 3 * 60

  @doc false
  def sweep_stale_geo do
    now = System.system_time(:second)

    # every driver needs the grace check (presence lives outside the row),
    # so this pass reads them all — but copies only {id, ts}, never the
    # cell or spot
    each_match(:geo_drivers, @driver_id_ts, fn {user_id, ts} ->
      if now - ts > @position_stale or past_grace?(user_id, now) do
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
      case Hoodride.Geo.grace_since(user_id) do
        nil -> true
        since -> now - since > @presence_grace
      end
  end
end
