defmodule Hoodride.SessionStamp do
  @moduledoc """
  The device you chose last wins — FENCING TOKENS for sessions.

  One live session per account. Choosing a device (opening the app,
  refreshing, "Use here") gets a new stamp, higher than every stamp issued
  before. A choice takes over. An AUTOMATIC reconnect (or our silent update
  reload) carries its tab's old stamp and gets in only if no higher stamp is
  known; otherwise it is told it moved. Standard pattern: Kleppmann's
  fencing tokens ("a number that increases"; whoever checks remembers the
  highest and refuses anything lower), Kafka's producer epoch fencing off
  zombies.

  Why: with "newest connection wins", a phone that never heard "you moved"
  (a tunnel; or the ~1-in-18k drop the monster hunt found BELOW the server:
  Bandit wrote the frame, the client never read it) reconnected by itself
  and kicked the laptop the user was on.

  Stamps are microseconds of `System.system_time/1`, never lower than the
  last one plus one: this runtime is in multi time warp mode (the default
  since OTP 26), so the clock may step backwards, and the guard keeps
  stamps rising anyway (the hybrid-logical-clock rule). Across a restart
  the clock carries on.

  Memory (ETS, no database): the highest stamp seen per account since boot.
  A restart wipes it — the known cost: a zombie that reconnects before the
  chosen device does gets in for those seconds, until the chosen device's
  higher stamp arrives and moves it. A device can only ever present its own
  account's stamps.
  """

  @highest :session_highest
  # account → the last time (ms) a prune pass saw a device of it connected
  @last_live :session_last_live
  @keep_offline_ms Hoodride.Limits.session_stamp_keep_ms()

  def init_table do
    Hoodride.ETS.new(@highest, [:named_table, :public, :set])
    Hoodride.ETS.new(@last_live, [:named_table, :public, :set])
    :persistent_term.put({__MODULE__, :last}, :atomics.new(1, signed: true))
    :ok
  end

  defp last_ref, do: :persistent_term.get({__MODULE__, :last})

  @doc "A new stamp: max(now, last + 1), atomically (never twice the same)."
  def issue(now \\ System.system_time(:microsecond)) do
    ref = last_ref()
    last = :atomics.get(ref, 1)
    new = max(now, last + 1)

    case :atomics.compare_exchange(ref, 1, last, new) do
      :ok -> new
      _taken -> issue(now)
    end
  end

  @doc "The latest stamp this server could have issued: anything above is forged."
  def latest, do: max(:atomics.get(last_ref(), 1), System.system_time(:microsecond))

  @doc "Remember `stamp` for `user_id` if it is the highest seen (it only rises)."
  def saw(user_id, stamp) do
    if :ets.insert_new(@highest, {user_id, stamp}) do
      :ok
    else
      case :ets.lookup(@highest, user_id) do
        [] ->
          saw(user_id, stamp)

        [{_, top}] when top >= stamp ->
          :ok

        [old] ->
          # compare-and-swap: another connect may have raised it meanwhile
          if :ets.select_replace(@highest, [{old, [], [{:const, {user_id, stamp}}]}]) == 1,
            do: :ok,
            else: saw(user_id, stamp)
      end
    end
  end

  @doc "A deleted account: its rows go (nothing left to fence for it)."
  def forget(user_id) do
    :ets.delete(@highest, user_id)
    :ets.delete(@last_live, user_id)
    :ok
  end

  @doc """
  The Sweeper's pass: an account's row goes once NO device of it has been
  connected for a day (owner's rule). The row matters only in gaps with
  nothing connected — it remembers which device was chosen last; while one
  is connected the live stamps fence. Dropped, an old tab waking up after a
  day with nothing else connected gets back in — what a restart already
  allows; never a second connection (a takeover closes the others).

  Each pass: connected → its last-seen time is now; not connected and never
  seen → the clock starts now (so the day counts from at most one pass after
  the last disconnect); not connected for over a day → both rows go.
  """
  def prune(now \\ System.system_time(:millisecond)) do
    Hoodride.ETS.each_match(@highest, [{{:"$1", :_}, [], [:"$1"]}], fn user_id ->
      cond do
        Registry.lookup(Hoodride.SocketStamps, user_id) != [] ->
          :ets.insert(@last_live, {user_id, now})

        :ets.insert_new(@last_live, {user_id, now}) ->
          :ok

        now - :ets.lookup_element(@last_live, user_id, 2) > @keep_offline_ms ->
          # gone a day: but re-check — a device may have connected meanwhile
          if Registry.lookup(Hoodride.SocketStamps, user_id) == [], do: forget(user_id)

        true ->
          :ok
      end
    end)
  end

  @doc "The highest stamp seen for `user_id` since boot, or nil."
  def highest(user_id) do
    case :ets.lookup(@highest, user_id) do
      [{_, top}] -> top
      [] -> nil
    end
  end

  @doc """
  Who gets in: `:take_over` or `:moved`. A choice always takes over; an
  automatic connect needs a stamp at least as high as every one known —
  the server's memory (`highest`) and the account's live sockets.
  """
  def decide(true, _stamp, _highest, _live), do: :take_over
  def decide(false, nil, _highest, _live), do: :moved

  def decide(false, stamp, highest, live) do
    if Enum.all?([highest | live], &(is_nil(&1) or stamp >= &1)), do: :take_over, else: :moved
  end
end
