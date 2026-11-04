defmodule HoodrideWeb.CurrentUser do
  @moduledoc "Puts the signed-in user (or nil) in `conn.assigns.current_user` — HoodrideWeb.Auth decides."
  @behaviour Plug

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    Plug.Conn.assign(
      conn,
      :current_user,
      HoodrideWeb.Auth.session_user(Plug.Conn.get_session(conn))
    )
  end
end
