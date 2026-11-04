defmodule HoodrideWeb.SessionGate do
  @moduledoc """
  Checked FIRST in every channel join (before HoodrideWeb.JoinBudget): a
  socket that lost the session (Hoodride.SessionStamp: an automatic
  reconnect while a newer choice exists) is refused with `session_moved`
  and closed. Its app shows "Use here". Closed by the server too, because
  Phoenix's client re-tries a refused join while its socket is open — an
  old app or a script would otherwise keep asking. Refused here, it spends
  no join budget and joins nothing.
  """

  @spec check(Phoenix.Socket.t()) :: :ok | {:error, map}
  def check(%Phoenix.Socket{assigns: %{moved: true}} = socket) do
    # the transport writes this join's reply first, then reads this
    send(socket.transport_pid, %Phoenix.Socket.Broadcast{
      topic: "user_socket:#{socket.assigns.user_id}",
      event: "disconnect",
      payload: %{}
    })

    {:error, %{reason: "session_moved"}}
  end

  def check(_socket), do: :ok
end
