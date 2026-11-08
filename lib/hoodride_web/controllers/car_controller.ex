defmodule HoodrideWeb.CarController do
  @moduledoc """
  "Your car" (ARCHITECTURE.md): GET /api/car — your own, for Settings and
  the go-online check; POST /api/car — save it. Read only when asked (opening
  Settings, going online), never on the busy paths. Who else sees it is the
  name lookup's business (WorldChannel `reveal`, rides, /api/state): riders
  only.
  """
  use HoodrideWeb, :controller

  alias Hoodride.Accounts

  def show(%{assigns: %{current_user: %{id: id}}} = conn, _params) do
    case Accounts.car_of(id) do
      {:ok, car} -> json(conn, %{car: car})
      {:error, :unavailable} -> busy(conn)
    end
  end

  def show(conn, _params), do: unauthenticated(conn)

  # JSON only, its fields only from it — never the address
  def update(%{assigns: %{current_user: %{id: id}}} = conn, _params) do
    if HoodrideWeb.JsonBody.json?(conn),
      do: save(conn, id, HoodrideWeb.JsonBody.object(conn)),
      else: HoodrideWeb.JsonBody.refuse(conn)
  end

  def update(conn, _params), do: unauthenticated(conn)

  defp save(conn, id, car) do
    case Accounts.set_car(id, car) do
      {:ok, car} ->
        json(conn, %{car: car})

      {:error, :invalid, fields} ->
        conn |> put_status(400) |> json(%{error: "invalid", fields: fields})

      {:error, :unavailable} ->
        busy(conn)
    end
  end

  defp unauthenticated(conn), do: conn |> put_status(401) |> json(%{error: "unauthenticated"})

  # the database couldn't answer: try again (the app says so)
  defp busy(conn), do: conn |> put_status(503) |> json(%{error: "busy"})
end
