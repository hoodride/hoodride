defmodule HoodrideWeb.SessionGate do
  @moduledoc """
  Checked FIRST in every channel join (before HoodrideWeb.JoinBudget):

    1. still signed in? The sign-in this socket was made from must still
       exist (Hoodride.SessionTokens). Phoenix subscribes a socket to its
       account's "disconnect" topic only AFTER connect/3 returns, so a
       socket that connected while a sign-out (or an account deletion) ran
       can miss that message — it is refused here at its first join, with
       `signed_out`, and closed. (Before, a connection pass made during a
       sign-out stayed valid for a day: server review, 2026-11-08.)
    2. a socket that lost the session (Hoodride.SessionStamp: an automatic
       reconnect while a newer choice exists) is refused with
       `session_moved` and closed. Its app shows "Use here".

  Closed by the server too, because Phoenix's client re-tries a refused join
  while its socket is open — an old app or a script would otherwise keep
  asking. Refused here, it spends no join budget and joins nothing.
  """

  @spec check(Phoenix.Socket.t()) :: :ok | {:error, map}
  def check(%Phoenix.Socket{assigns: assigns} = socket) do
    cond do
      not HoodrideWeb.Auth.signed_in?(assigns.user_id, assigns[:token_hash]) ->
        refuse(socket, "signed_out")

      assigns[:moved] == true ->
        refuse(socket, "session_moved")

      true ->
        :ok
    end
  end

  defp refuse(socket, reason) do
    # the transport writes this join's reply first, then reads this
    send(socket.transport_pid, %Phoenix.Socket.Broadcast{
      topic: "user_socket:#{socket.assigns.user_id}",
      event: "disconnect",
      payload: %{}
    })

    {:error, %{reason: reason}}
  end
end
