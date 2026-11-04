defmodule Hoodride.AvatarsOffPlug do
  @moduledoc """
  Tests: the photo download's default stand-in (config/test.exs
  `:avatar_req`) — every photo request answers 404, so a sign-in test that
  isn't about photos never reaches Google or Facebook and gets no photo.
  Tests about photos stub their own (`Req.Test` under `Hoodride.Avatars`).
  """
  @behaviour Plug

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts), do: Plug.Conn.send_resp(conn, 404, "")
end
