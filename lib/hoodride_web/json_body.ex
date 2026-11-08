defmodule HoodrideWeb.JsonBody do
  @moduledoc """
  Requests that take a body take JSON only (delete account, save car —
  server review, 2026-11-08): a form can't send it, and another site's page
  can't send it to us without asking first (a CORS preflight we never
  answer). Its fields come from the BODY only — never the address: the
  merged params let `?confirm=DELETE` count whatever the body said.
  """
  import Plug.Conn

  @doc "Is the body JSON (`application/json`, any case, parameters ignored)?"
  def json?(conn) do
    case get_req_header(conn, "content-type") do
      [type] -> match?({:ok, "application", "json", _}, Plug.Conn.Utils.media_type(type))
      _ -> false
    end
  end

  @doc """
  The body's fields (a JSON list or number arrives as `%{"_json" => …}`:
  no fields the callers know — refused by their own checks).
  """
  def object(%Plug.Conn{body_params: %{} = params}) when not is_struct(params), do: params
  def object(_conn), do: %{}

  @doc "415: only JSON here."
  def refuse(conn),
    do: conn |> put_status(415) |> Phoenix.Controller.json(%{error: "json_only"})
end
