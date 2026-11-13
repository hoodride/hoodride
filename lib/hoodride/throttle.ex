defmodule Hoodride.Throttle do
  @moduledoc """
  Per-USER and per-PAIR limits that must hold across all of a user's tabs,
  so they live in Hammer's shared table (Hoodride.RateLimit). Every budget
  is defined here and nowhere else; channel code never talks to Hammer.

  The hot-path flow limits (map syncs, channel events, ride actions, joins,
  connects) are per user too, but need exact millisecond timing and atomic
  spends: Hoodride.RateBudget.

  TAKEN FIRST, GIVEN BACK ON A REFUSAL (owner, 2026-11-13, step 7). An
  allowance is taken in one atomic step (`take_*`: Hammer's `hit` adds and
  checks at once) before the message or request goes, and given back
  (`give_back_*`) if it doesn't — so a REFUSED contact still spends nothing
  (server review, 2026-11-08: a rider tapping Request during a cooldown
  used up the hour's new contacts without reaching anyone). It used to be
  looked at first and charged after — two steps: two live sessions of one
  account (a hand-over's moment) could both pass the last allowed contact.
  Proven: HoodrideWeb.LimitRaceTest.
  """

  alias Hoodride.RateLimit

  @minute 60_000
  @hour 3_600_000

  # a fast real chat is ~10-15 short messages a minute
  @messages_per_minute Hoodride.Limits.messages_per_minute()
  # rapid back-and-forth with one person is ~10 a minute
  @pair_messages_per_minute Hoodride.Limits.pair_messages_per_minute()
  # a rider contacts 3-5 drivers, a driver a handful of riders; 20 leaves a
  # rider in a quiet area 4-5 tries at a ride even with many "no"s, and still
  # slows a spammer working through the whole neighbourhood (owner's pick,
  # 2026-10-28: 10 was tight there, 30+ would reach nearly everyone on a
  # small map). Only COLD contact counts: replying, or messaging someone you
  # already talk to, is free.
  @new_conversations_per_hour Hoodride.Limits.new_chats_per_hour()
  # "no" sticks for a minute, but a genuine retry is still possible
  @request_cooldown Hoodride.Limits.request_cooldown_ms()

  @doc """
  Take one message (the total and the per-person allowance) for `from_id`
  → `to_id`: `:ok` (taken), or `{:deny, ms}` with nothing taken — when both
  refuse, the LATER wait (the real one).
  """
  def take_message(from_id, to_id) do
    take_all([
      {{:msg, from_id}, @minute, @messages_per_minute},
      {{:msg_pair, from_id, to_id}, @minute, @pair_messages_per_minute}
    ])
  end

  @doc "The message didn't go after all: its allowance back."
  def give_back_message(from_id, to_id) do
    RateLimit.give_back({:msg, from_id})
    RateLimit.give_back({:msg_pair, from_id, to_id})
  end

  @doc "Take one cold contact (someone new): `:ok`, or `{:deny, ms}` with nothing taken."
  def take_new_conversation(from_id),
    do: take_all([{{:new_conv, from_id}, @hour, @new_conversations_per_hour}])

  @doc "The cold contact didn't go through after all: it back."
  def give_back_new_conversation(from_id), do: RateLimit.give_back({:new_conv, from_id})

  @doc """
  Take one, as a real contact would. Only for the browser journeys'
  `cold_used_up` (test/browser/journeys_test.exs), which spends the hour as
  if real contacts had been made.
  """
  def new_conversation(from_id), do: take_new_conversation(from_id)

  @doc """
  Start the re-request cooldown for this pair. Called when a request ENDS
  with a decline or a cancel, so "no" sticks for a full minute after the
  answer — however long the driver took to give it. (Starting the clock at
  request time let a slow decline skip the cooldown entirely.)
  """
  def start_request_cooldown(rider_id, driver_id) do
    RateLimit.set({:req_cd, rider_id, driver_id}, @request_cooldown, 1)
    :ok
  end

  @doc "Is this rider still cooling down for this driver? Read-only."
  def request_cooldown(rider_id, driver_id) do
    key = {:req_cd, rider_id, driver_id}

    if RateLimit.get(key, @request_cooldown) >= 1 do
      wait = RateLimit.expires_at(key, @request_cooldown) - System.system_time(:millisecond)
      {:deny, max(wait, 1)}
    else
      :ok
    end
  end

  # each allowance taken in one atomic step (`hit` adds, then compares —
  # a refused hit still added: given back); any refused → all given back,
  # the LATER wait named (never 0 or less)
  defp take_all(limits) do
    hits = for {key, scale, limit} <- limits, do: {key, RateLimit.hit(key, scale, limit)}

    case for({_, {:deny, ms}} <- hits, do: ms) do
      [] ->
        :ok

      waits ->
        for {key, _} <- hits, do: RateLimit.give_back(key)
        {:deny, max(Enum.max(waits), 1)}
    end
  end
end
