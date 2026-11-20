defmodule HoodrideWeb.HealthController do
  @moduledoc "GET /api/health: 200 when the database can be written, 503 when not (HoodrideWeb.Health)."
  use HoodrideWeb, :controller

  def show(conn, _params) do
    case HoodrideWeb.Health.check() do
      :ok -> conn |> put_status(200) |> json(%{ok: true})
      :down -> conn |> put_status(503) |> json(%{ok: false})
    end
  end
end
