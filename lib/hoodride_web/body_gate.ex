defmodule HoodrideWeb.BodyGate do
  @moduledoc """
  Request bodies, before anything reads them (crash review 2026-11-13).

  Plug.Parsers reads only JSON, and only `Hoodride.Limits.http_body_bytes`
  of it; any other body is left unread. But on a kept-alive connection
  Bandit then reads the rest itself after the answer, to reach the next
  request (deps/bandit/lib/bandit/http1/socket.ex `ensure_completed/1`) —
  up to 8 MB held in memory per request, from anyone, signed out. It skips
  that read when the answer closes the connection (`keepalive: false`), so:

    * a body DECLARED over the limit: 413 at once, connection closed —
      never read;
    * any other body that isn't JSON (Hood Ride's app sends only small
      JSON; the browser's CSP reports read their own few KB): answered as
      usual, then the connection closed — its rest never read.

  Closing costs only the next request a new local connection from
  cloudflared (a Unix socket). HoodrideWeb.BodyGateTest.
  """
  @behaviour Plug
  import Plug.Conn

  @limit Hoodride.Limits.http_body_bytes()

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    cond do
      declared_length(conn) > @limit ->
        conn
        |> put_resp_header("connection", "close")
        |> put_resp_content_type("application/json")
        |> send_resp(413, ~s({"error":"too_large"}))
        |> halt()

      has_body?(conn) and not json?(conn) ->
        register_before_send(conn, &put_resp_header(&1, "connection", "close"))

      true ->
        conn
    end
  end

  # the declared size (0 if none, or unreadable: then the parsers' own
  # counting limit still holds for JSON, and anything else is closed below)
  defp declared_length(conn) do
    case get_req_header(conn, "content-length") do
      [v] ->
        case Integer.parse(v) do
          {n, ""} when n >= 0 -> n
          _ -> 0
        end

      _ ->
        0
    end
  end

  defp has_body?(conn),
    do: declared_length(conn) > 0 or get_req_header(conn, "transfer-encoding") != []

  # the types Hood Ride reads: the app's JSON, and the browser's own CSP
  # reports (read by HoodrideWeb.CspReportController, a few KB at most)
  @read ["json", "csp-report", "reports+json"]

  defp json?(conn) do
    case get_req_header(conn, "content-type") do
      [type] ->
        case Plug.Conn.Utils.media_type(type) do
          {:ok, "application", sub, _} -> sub in @read
          _ -> false
        end

      _ ->
        false
    end
  end
end
