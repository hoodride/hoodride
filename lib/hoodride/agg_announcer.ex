defmodule Hoodride.AggAnnouncer do
  @moduledoc """
  The ONE sender of a hex's counts (cars, ✋) to the people watching it.

  The map writers (Hoodride.GeoWriter) run in parallel, one per core, by
  user id — so two of them can change the same hex's count at the same
  moment. The count itself never goes wrong (each change is one atomic
  `:ets.update_counter`), but when each writer ALSO read the count and
  sent it, two writers' sends could cross: one read 17, another changed it
  to 16 and sent "16", then the first one's "17" arrived last — watchers
  left on 17 until the hex next changed. A re-read after sending (3 tries)
  narrowed it; under a rush the tries ran out and a stale number still
  landed last (AggregatesTest's stress test, 2026-11-23).

  Now the writers only change the count and leave a note here — "this hex,
  these sides moved" — and this process reads the count WHEN it handles
  the note and sends it. One sender per hex: Erlang delivers one process's
  messages to another in the order sent, so watchers get them in order; and
  every note arrives after its change, so the last note is handled after
  the last change and its read is the truth. No retries, no bound, no
  memory kept: each note sends the CURRENT number of the sides it names —
  only those (the privacy law: a side is sent only when it changed, never
  because the other side did). The notes already waiting are taken with
  it and merged per hex: a rush in one hex is one read, one count per
  side (handle_cast).

  Partitioned like the writers (one per scheduler: 1 on a 1-core server),
  by HEX — the same hex always lands on the same announcer.
  """
  use GenServer
  require Logger

  def start_link(_), do: GenServer.start_link(__MODULE__, nil)

  @impl true
  def init(_), do: {:ok, nil}

  # most notes taken together at once: one pass bounded, so the queue's
  # newest still wait at most one batch
  @batch 1000

  # (a note the writers left: Hoodride.Geo.settle_and_broadcast). The notes
  # already waiting are taken WITH it, merged per hex — the sides any of
  # them named — and each hex read once: a rush of 30 cars in one hex was 30
  # identical counts (owner, 2026-11-23); now one, the true one. Still read
  # after every change queued so far: the last count is the truth. Still
  # only the sides some note named: the privacy law. (Other messages — a
  # flush, the system's — stay queued, in their order.)
  @impl true
  def handle_cast({:announce, cell, sides}, s) do
    {order, merged} = take_waiting(@batch, [cell], %{cell => sides})

    for c <- Enum.reverse(order) do
      announce(c, Map.fetch!(merged, c))
    end

    {:noreply, s}
  end

  defp take_waiting(0, order, merged), do: {order, merged}

  defp take_waiting(left, order, merged) do
    receive do
      {:"$gen_cast", {:announce, cell, sides}} ->
        case merged do
          %{^cell => had} ->
            take_waiting(left - 1, order, Map.put(merged, cell, Enum.uniq(had ++ sides)))

          _ ->
            take_waiting(left - 1, [cell | order], Map.put(merged, cell, sides))
        end
    after
      0 -> {order, merged}
    end
  end

  defp announce(cell, sides) do
    Hoodride.Geo.announce_now(cell, sides)
  rescue
    # (one bad note never stops the others — as the writers: logged by
    # kind only, never the payload)
    e -> Logger.error("count announcement failed: #{inspect(e.__struct__)}")
  end

  # every note queued before this call is handled first (tests). A note a
  # writer sent before answering its caller is queued ahead of a later
  # call — on one node, a local send is in the mailbox when it returns; not
  # a language guarantee across two senders (Geo.flush_announcements)
  @impl true
  def handle_call(:flush, _from, s), do: {:reply, :ok, s}
end
