defmodule HoodrideWeb.CurrentUser do
  @moduledoc "Puts the signed-in user (or nil) in `conn.assigns.current_user` — HoodrideWeb.Auth decides."
  @behaviour Plug

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case HoodrideWeb.Auth.session_user(Plug.Conn.get_session(conn)) do
      # their sign-ins not in memory and the database couldn't answer: "try
      # again" (the app retries), NEVER a 401 — that's "signed out", and
      # the app would show the sign-in screen (owner, 2026-11-17)
      :unavailable ->
        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.put_resp_header("retry-after", retry_after())
        |> Plug.Conn.send_resp(503, ~s({"error":"unavailable"}))
        |> Plug.Conn.halt()

      user ->
        Plug.Conn.assign(conn, :current_user, user)
    end
  end

  @doc """
  The "try again" wait, in whole seconds (the header's unit): 2 or 3 — every
  phone opening the app in a database stall was told "2" and asked again on
  one beat (owner, 2026-11-20).
  """
  def retry_after, do: Integer.to_string(1 + :rand.uniform(2))
end
