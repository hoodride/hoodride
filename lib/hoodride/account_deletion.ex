defmodule Hoodride.AccountDeletion do
  @moduledoc """
  Delete an account — the privacy policy's promise, and Meta's data-deletion
  rule. Refused during a ride or while your own ride request waits (end or
  cancel it first, as with sign-out: vanishing mid-ride strands the other
  person). Otherwise, in this order:

    1. the database FIRST: the account's row deleted — its sign-in tokens
       go with it (the database's cascade). If it fails, NOTHING has changed
       and the person can simply try again. (It used to revoke first and
       delete the row last: a failed delete left them signed out, unable to
       retry, and the account came back at their next sign-in.)
    2. its tokens dropped from memory too (Hoodride.SessionTokens): every
       session and connection pass refused from now (a pass names the token
       it came from — HoodrideWeb.Auth), every live action too, and after a
       restart as well (the tokens are gone from the table);
    3. live state: off the map (car and ✋), incoming requests declined
       (each rider told), chats closed (the partner told), presence and the
       session stamp forgotten;
    4. every device disconnected (the caller ends the session cookie).

  After this nothing of the account is kept (logs, which hold no names,
  positions or messages, age out in 14 days). No record of the deletion
  either: the old one (Hoodride.SignOuts, kept 30 days) refused nothing the
  erased tokens didn't — and a sign-in/delete loop piled them up (the
  delete loop, 2026-11-12). Signing in again with the same provider account
  starts a NEW account.
  """
  alias Hoodride.{Accounts, Chat, Geo, Repo, Requests, Rides, SessionStamp}

  @doc "`:ok`, or `{:error, :in_ride | :request_waiting | :failed}` (nothing deleted)."
  def delete(user_id) do
    cond do
      Rides.ride_id_of_user(user_id) != nil -> {:error, :in_ride}
      Requests.open_request_of(user_id) != nil -> {:error, :request_waiting}
      true -> do_delete(user_id)
    end
  end

  defp do_delete(user_id) do
    case erase(user_id) do
      {:ok, photo} ->
        # the photo copy goes too (Hoodride.Avatars) — after the database
        # step, so a failed delete leaves it in place
        Hoodride.Avatars.remove(photo)
        after_erase(user_id)

      error ->
        error
    end
  end

  # the database step: all or nothing. Only the database being unable to
  # answer becomes {:error, :failed}; any other error (a bug) still crashes.
  defp erase(user_id) do
    {:ok, photo} =
      Repo.transaction(fn ->
        user = Accounts.get_user(user_id)
        if user, do: Repo.delete!(user)
        user && user.photo
      end)

    {:ok, photo}
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error] -> {:error, :failed}
  end

  defp after_erase(user_id) do
    # its sign-ins went with the row (the database's cascade): from memory
    # too — FIRST, so a live connection can't put anything back on the map
    # meanwhile (every action checks it: HoodrideWeb.UserChannel)
    Hoodride.SessionTokens.forget(user_id)
    # signed out everywhere — THEN a ride or request that slipped past the
    # check in delete/1 meanwhile is ended/withdrawn (A1)
    Rides.after_sign_out(user_id)

    # off the map; going offline also declines every incoming request, each
    # rider told (Geo's offline_core → Requests.decline_all_for_driver)
    Geo.driver_offline(user_id)
    Geo.hand_down(user_id)

    for %{peer_id: peer} <- Chat.conversations_for(user_id),
        do: Chat.delete_conversation(Chat.pair_key(user_id, peer))

    Geo.forget_presence(user_id)
    SessionStamp.forget(user_id)

    HoodrideWeb.Endpoint.broadcast("user_socket:#{user_id}", "disconnect", %{})
    :ok
  end
end
