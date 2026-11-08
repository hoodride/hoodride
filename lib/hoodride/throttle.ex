defmodule Hoodride.Throttle do
  @moduledoc """
  Per-USER and per-PAIR limits that must hold across all of a user's tabs,
  so they live in Hammer's shared table (Hoodride.RateLimit). Every budget
  is defined here and nowhere else; channel code never talks to Hammer.

  The hot-path flow limits (map syncs, channel events, ride actions, joins,
  connects) are per user too, but need exact millisecond timing and atomic
  spends: Hoodride.RateBudget.

  A REFUSED contact spends nothing (server review, 2026-11-08): the
  allowances are looked at first (`*_allowed`) and charged only once the
  request or message has gone through (`sent_message/2`,
  `started_conversation/1`). They used to be charged before the refusals —
  a rider tapping Request during a cooldown, or while waiting on another
  driver, used up the hour's new contacts without reaching anyone. Looking
  and charging are two steps: two live sessions of one account at the same
  instant (only during a hand-over) can both pass at the last one, so the
  limit can be passed by one per extra session. Never charged for nothing.
  """

  alias Hoodride.RateLimit

  @minute 60_000
  @hour 3_600_000

  # a fast real chat is ~10-15 short messages a minute
  @messages_per_minute 30
  # rapid back-and-forth with one person is ~10 a minute
  @pair_messages_per_minute 15
  # a rider contacts 3-5 drivers, a driver a handful of riders; 20 leaves a
  # rider in a quiet area 4-5 tries at a ride even with many "no"s, and still
  # slows a spammer working through the whole neighbourhood (owner's pick,
  # 2026-10-28: 10 was tight there, 30+ would reach nearly everyone on a
  # small map). Only COLD contact counts: replying, or messaging someone you
  # already talk to, is free.
  @new_conversations_per_hour 20
  # "no" sticks for a minute, but a genuine retry is still possible
  @request_cooldown @minute

  @doc """
  May `from_id` message `to_id` now? Read-only: `:ok`, or `{:deny, ms}` —
  when both the total and the per-person limit refuse, the LATER wait (the
  real one).
  """
  def message_allowed(from_id, to_id) do
    latest([
      peek({:msg, from_id}, @minute, @messages_per_minute),
      peek({:msg_pair, from_id, to_id}, @minute, @pair_messages_per_minute)
    ])
  end

  @doc "A message went: charge the total and the per-person allowance."
  def sent_message(from_id, to_id) do
    RateLimit.inc({:msg, from_id}, @minute)
    RateLimit.inc({:msg_pair, from_id, to_id}, @minute)
    :ok
  end

  @doc "May `from_id` start a cold contact (someone new) now? Read-only."
  def new_conversation_allowed(from_id),
    do: peek({:new_conv, from_id}, @hour, @new_conversations_per_hour)

  @doc "A cold contact went through (a first message, or a request): charge it."
  def started_conversation(from_id) do
    RateLimit.inc({:new_conv, from_id}, @hour)
    :ok
  end

  @doc """
  Look, and charge if allowed — in one call. Only for the browser journeys'
  `cold_used_up` (test/browser/journeys_test.exs), which spends the hour as
  if real contacts had been made.
  """
  def new_conversation(from_id) do
    with :ok <- new_conversation_allowed(from_id), do: started_conversation(from_id)
  end

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

  # the allowance used up (count at the limit): refused, with the wait
  # until its window ends (never 0 or less: the window can end between the
  # two reads)
  defp peek(key, scale, limit) do
    if RateLimit.get(key, scale) >= limit do
      {:deny, max(RateLimit.expires_at(key, scale) - System.system_time(:millisecond), 1)}
    else
      :ok
    end
  end

  defp latest(results) do
    case for({:deny, ms} <- results, do: ms) do
      [] -> :ok
      waits -> {:deny, Enum.max(waits)}
    end
  end
end
