defmodule Hoodride.AccountDeletion do
  @moduledoc """
  Delete an account — the privacy policy's promise, and Meta's data-deletion
  rule. Refused during a ride or while your own ride request waits (end or
  cancel it first, as with sign-out: vanishing mid-ride strands the other
  person). Otherwise, in this order:

    1. shut down FIRST (sixteenth review, 2026-11-19 — owner: go): signed
       out (its sign-ins deleted, database and memory: no request or
       connection passes from now), its connections closed and waited for
       (none can send an update after), a ride that slipped past the check
       above ended, its car and ✋ off the map — both removals sent at once
       and waited for, up to 5 s (a wedged map writer: they stay queued and
       land when it resumes; the deletion goes on). It erased first and
       tore down after: in
       between, someone who blocked it, loading their blocks, read "not
       blocked" (the database had none left) and saw its car or ✋; an
       update on its way put the car back; a timed-out removal let the
       blocks go while the car was still there. The cost: a failed erase
       (the database refusing — rare) leaves the account intact but signed
       out and offline; signing in again, they can retry;
    2. the database: the account's row deleted — its blocks and anything
       else go with it (the database's cascade);
    3. shut down again, in memory only — no database write that could fail
       after the erase (a sign-in made just before the row went: its token
       out of memory, its connection closed, off the map), then memory: its blocks (both
       sides), chats closed (the partner told), presence and the session
       stamp forgotten, every device told to disconnect (the caller ends
       the session cookie).

  (Tests: a channel joined with Phoenix.ChannelTest has no real
  connection, so "disconnect" doesn't close it — the deletion stops it
  after the wait, and such a channel is LINKED to the test process: the
  test dies with it. Leave the channel first, or unlink it, before
  deleting its account.)

  After this nothing of the account is kept (logs, which hold no names,
  positions or messages, age out in 14 days). No record of the deletion
  either: the old one (Hoodride.SignOuts, kept 30 days) refused nothing the
  erased tokens didn't — and a sign-in/delete loop piled them up (the
  delete loop, 2026-11-12). Signing in again with the same provider account
  starts a NEW account.
  """
  alias Hoodride.{Accounts, Chat, Geo, Repo, Requests, Rides, SessionStamp}

  @doc """
  `:ok`, or (nothing deleted) `{:error, :in_ride | :request_waiting}`;
  `{:error, :failed}` — the database couldn't sign them out: NOTHING
  changed, still signed in; `{:error, :failed_signed_out}` — signed out
  and off the map, then the database couldn't erase: the account intact,
  signing in again they can retry.
  """
  def delete(user_id) do
    cond do
      Rides.ride_id_of_user(user_id) != nil -> {:error, :in_ride}
      Requests.open_request_of(user_id) != nil -> {:error, :request_waiting}
      true -> do_delete(user_id)
    end
  end

  defp do_delete(user_id) do
    with :ok <- shut_down(user_id),
         {:ok, photo, partners} <- erase_after_shut_down(user_id) do
      # the photo copy goes too (Hoodride.Avatars) — after the database
      # step, so a failed delete leaves it in place
      Hoodride.Avatars.remove(photo)
      # (a sign-in made between the shutdown and the erase: its token went
      # with the row — out of memory, its connection and anything it put on
      # the map go now. Memory only: a database write here could fail after
      # the erase, leaving the rest undone — seventeenth review)
      Hoodride.SessionTokens.forget(user_id)
      # (its waits a fifth as long: it only catches a late sign-in — the
      # full waits twice ran past the app's 15 s request limit with a
      # wedged writer; twentieth review, 2026-11-19)
      take_down(user_id, 5)
      after_erase(user_id, partners)
    end
  end

  # how long the shutdown waits for the account to be off the map, both
  # changes together: a merely busy writer (overload) is waited for; a
  # WEDGED one isn't waited on forever — the deletion still completes
  # (Hoodride.OverloadTest), the removal stays queued and lands as soon as
  # the writer resumes (only then can the old gap remain: the blocks gone
  # before the car)
  @off_map_wait_ms 5_000
  # how long it waits for its connections to close before stopping them
  @close_wait_ms 2_000

  # signed out, connections closed, off the map — each waited for: `:ok`, or
  # `{:error, :failed}` when the database couldn't sign them out (then
  # nothing has changed)
  defp shut_down(user_id) do
    case Hoodride.SessionTokens.revoke_all(user_id) do
      {:ok, _} -> take_down(user_id, 1)
      {:error, _} -> {:error, :failed}
    end
  end

  # (signed out already) connections closed, a ride ended, off the map —
  # each wait the full one divided by `part`
  defp take_down(user_id, part) do
    close_connections(user_id, div(@close_wait_ms, part))
    # a ride or request that slipped past the check in delete/1 (A1)
    Rides.after_sign_out(user_id)
    # off the map; going offline also declines every incoming request, each
    # rider told (Geo's offline_core → Requests.decline_all_for_driver)
    wait_ms = Application.get_env(:hoodride, :deletion_off_map_wait_ms, @off_map_wait_ms)
    off_map(user_id, System.monotonic_time(:millisecond) + div(wait_ms, part))
    :ok
  end

  # every connection of theirs told to disconnect, and waited for: an
  # update already on its way finishes (or never starts) before the map is
  # cleared. One that doesn't close in time is stopped — the account is
  # going; nothing of it should run on
  defp close_connections(user_id, wait_ms) do
    pids =
      for reg <- [Hoodride.UserChannels, Hoodride.WorldChannels],
          {pid, _} <- Registry.lookup(reg, user_id),
          uniq: true,
          do: pid

    refs = Map.new(pids, &{Process.monitor(&1), &1})
    HoodrideWeb.Endpoint.broadcast("user_socket:#{user_id}", "disconnect", %{})
    deadline = System.monotonic_time(:millisecond) + wait_ms
    left = await_down(refs, deadline)

    for {ref, pid} <- left do
      Process.exit(pid, :kill)

      receive do
        {:DOWN, ^ref, :process, _, _} -> :ok
      end
    end

    :ok
  end

  defp await_down(refs, _deadline) when map_size(refs) == 0, do: refs

  defp await_down(refs, deadline) do
    wait = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:DOWN, ref, :process, _, _} when is_map_key(refs, ref) ->
        await_down(Map.delete(refs, ref), deadline)
    after
      wait -> refs
    end
  end

  # both removals SENT at once (a call is queued before it waits — 1 ms is
  # enough to send it), each once: then waited for with a change-nothing
  # "caught up?" (GeoWriter op :caught_up) until `deadline`. Re-sent only when the
  # writer restarted (what it held is lost). Before, a timed-out try sent
  # the removal again — every try one more copy on a wedged writer — and
  # the car's removal could take the whole wait, the ✋'s never sent
  # (seventeenth review, 2026-11-19)
  #
  # ONE writer, looked up once, gets all three: by name each time, a writer
  # replaced in between (its queue lost) answered "caught up" for removals
  # it never held — nothing re-sent (eighteenth review, 2026-11-19)
  defp off_map(user_id, deadline) do
    writer = GenServer.whereis({:via, PartitionSupervisor, {Hoodride.GeoWriters, user_id}})

    sent =
      for op <- [{:driver_offline, user_id}, {:hand_down, user_id}],
          do: writer && Hoodride.GeoWriter.call(writer, op, 1)

    # (tests: a pause after the removals are sent)
    hook(:removals_sent)
    left = deadline - System.monotonic_time(:millisecond)

    answer =
      cond do
        left <= 0 -> :out_of_time
        nil in sent or {:error, :unavailable} in sent -> {:error, :unavailable}
        true -> Hoodride.GeoWriter.call(writer, {:caught_up, user_id}, left)
      end

    case answer do
      # that writer is gone (or none yet): what it held is lost — again
      {:error, :unavailable} ->
        Process.sleep(writer_retry_ms())
        off_map(user_id, deadline)

      _ ->
        :ok
    end
  end

  # (already signed out: a failed erase says so — the app told them "please
  # try again", and they were signed out; twentieth review, 2026-11-19)
  defp erase_after_shut_down(user_id) do
    case erase(user_id) do
      {:error, :failed} -> {:error, :failed_signed_out}
      other -> other
    end
  end

  # the database step: all or nothing. Only the database being unable to
  # answer becomes {:error, :failed}; any other error (a bug) still crashes.
  # IMMEDIATE: the write lock from the start. It read first, then deleted —
  # started as a reader (SQLite's default), a write saved in between failed
  # the deletion at once, busy_timeout or not (Hoodride.DeletionBusyTest)
  defp erase(user_id) do
    # (tests: a pause just before the row goes)
    hook(:erasing)

    {:ok, {photo, partners}} =
      Repo.transaction(
        fn ->
          user = Accounts.get_user(user_id)
          # (who its blocks name, before the cascade deletes them: memory
          # forgets the others' rows naming it by key — Blocks.forget/2)
          partners = Hoodride.Blocks.partners(user_id)
          if user, do: Repo.delete!(user)
          {user && user.photo, partners}
        end,
        mode: :immediate
      )

    {:ok, photo, partners}
  rescue
    e -> if Hoodride.Repo.down?(e), do: {:error, :failed}, else: reraise(e, __STACKTRACE__)
  end

  defp hook(step) do
    if hook = Application.get_env(:hoodride, :account_deletion_hook), do: hook.(step)
  end

  defp after_erase(user_id, partners) do
    # (its sign-ins went with the row; any left in memory too)
    Hoodride.SessionTokens.forget(user_id)

    # its blocks went with the row too (the cascade): from memory, both
    # sides — it's off the map and disconnected already (shut_down/1):
    # nobody it blocked, or who blocked it, can see it, nor it them
    Hoodride.Blocks.forget(user_id, partners)

    for %{peer_id: peer} <- Chat.conversations_for(user_id),
        do: Chat.delete_conversation(Chat.pair_key(user_id, peer))

    Geo.forget_presence(user_id)
    SessionStamp.forget(user_id)

    HoodrideWeb.Endpoint.broadcast("user_socket:#{user_id}", "disconnect", %{})
    :ok
  end

  @doc false
  # a map writer restarting: asked again after a spread pause (5–15 ms) —
  # deletions running together asked on one 10 ms beat (owner, 2026-11-20:
  # "make sure nowhere in code got a hardcoded wait")
  def writer_retry_ms, do: 4 + :rand.uniform(11)
end
