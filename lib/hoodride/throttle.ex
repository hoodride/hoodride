defmodule Hoodride.Throttle do
  @moduledoc """
  Per-USER and per-PAIR limits that must hold across all of a user's tabs,
  so they live in Hammer's shared table (Hoodride.RateLimit). Every budget
  is defined here and nowhere else; channel code never talks to Hammer.

  The hot-path flow limits (map syncs, channel events, ride actions, joins,
  connects) are per user too, but need exact millisecond timing and atomic
  spends: Hoodride.RateBudget.
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

  @doc "A message from `from_id` to `to_id`: total budget, then per-pair."
  def message(from_id, to_id) do
    with :ok <- hit({:msg, from_id}, @minute, @messages_per_minute) do
      hit({:msg_pair, from_id, to_id}, @minute, @pair_messages_per_minute)
    end
  end

  @doc "Starting cold contact (first message or request to someone new)."
  def new_conversation(from_id) do
    hit({:new_conv, from_id}, @hour, @new_conversations_per_hour)
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

  defp hit(key, scale, limit) do
    case RateLimit.hit(key, scale, limit) do
      {:allow, _count} -> :ok
      {:deny, retry_ms} -> {:deny, retry_ms}
    end
  end
end
