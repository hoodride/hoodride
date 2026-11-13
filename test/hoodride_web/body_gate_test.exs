defmodule HoodrideWeb.BodyGateTest do
  @moduledoc """
  Crash review 2026-11-13 (memory). Plug.Parsers reads only JSON, and only
  64 KB of it; any other body was left unread — and after the answer, on a
  kept-alive connection, Bandit READ IT ANYWAY to reach the next request
  (deps/bandit http1/socket.ex `ensure_completed`): up to 8 MB held in
  memory per request, from anyone, signed out, on any address.

  Bandit skips that read when the answer closes the connection
  (`ensure_completed(%{keepalive: false})`). So: a body declared over the
  limit is refused at once (413, closed, never read); any other body that
  isn't JSON is answered as usual, and the connection closed after it.
  Nothing Hood Ride's app sends is affected (it sends small JSON).
  """
  use HoodrideWeb.ConnCase, async: true

  @limit Hoodride.Limits.http_body_bytes()

  test "a body declared over the limit: 413 at once, the connection closed" do
    conn =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("content-length", Integer.to_string(@limit + 1))
      |> post("/api/client-error", "{}")

    assert conn.status == 413
    assert get_resp_header(conn, "connection") == ["close"]
  end

  test "a body that isn't JSON: answered, and the connection closed (its rest never read)" do
    for {path, type} <- [
          {"/api/client-error", "text/plain"},
          {"/api/nothing-here", "application/octet-stream"},
          {"/", "text/plain"}
        ] do
      conn =
        build_conn()
        |> put_req_header("content-type", type)
        |> put_req_header("content-length", "1")
        |> post(path, "x")

      assert get_resp_header(conn, "connection") == ["close"], "#{path} #{type}"
    end

    # (no declared size at all — chunked — the same)
    conn =
      build_conn()
      |> put_req_header("content-type", "text/plain")
      |> put_req_header("transfer-encoding", "chunked")
      |> post("/api/client-error", "x")

    assert get_resp_header(conn, "connection") == ["close"]
  end

  test "the app's own requests (small JSON, or none) keep their connection" do
    conn = build_conn() |> get("/")
    assert get_resp_header(conn, "connection") == []

    conn =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("content-length", "15")
      |> post("/api/client-error", Jason.encode!(%{"message" => "x"}))

    assert get_resp_header(conn, "connection") == []

    # the browser's own CSP reports are read by their controller: kept too
    for type <- ["application/csp-report", "application/reports+json"] do
      conn =
        build_conn()
        |> put_req_header("content-type", type)
        |> put_req_header("content-length", "2")
        |> post("/api/csp-report", "{}")

      assert get_resp_header(conn, "connection") == [], type
    end
  end
end
