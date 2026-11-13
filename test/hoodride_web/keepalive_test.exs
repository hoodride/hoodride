defmodule HoodrideWeb.KeepaliveTest do
  @moduledoc """
  Over a REAL HTTP connection (Bandit, as in prod): cloudflared sends many
  visitors' requests one after another on the same connection. A handler
  that reads the body but answers on the conn from BEFORE the read leaves
  Bandit thinking the body is still unread — it then "drains" it from the
  connection, eating the start of the NEXT request (deploy day, 2026-10-29:
  bursts of CSP reports from the owner's phone, then "Request line HTTP
  error: <a piece of a session cookie>" and "Read timeout" in the logs).
  It shows only when the body arrives in its own packet after the headers
  (as through the tunnel) — sent in one piece, the stale state still held
  it. ConnTest can't see any of this (no socket); this does.
  """
  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  setup do
    # the report receiver is off by default (HoodrideWeb.CSP); this guards
    # body-reading code over a real connection, so switch it on
    Application.put_env(:hoodride, :csp_reporting, true)
    on_exit(fn -> Application.delete_env(:hoodride, :csp_reporting) end)

    pid =
      start_supervised!(
        {Bandit, plug: HoodrideWeb.Endpoint, scheme: :http, ip: :loopback, port: 0}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(pid)
    %{port: port}
  end

  # sends `parts` one by one with a pause, then returns every complete
  # response's status, in order
  defp exchange(port, parts, want) do
    {:ok, s} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false, nodelay: true])

    for part <- parts do
      :ok = :gen_tcp.send(s, part)
      Process.sleep(50)
    end

    statuses = collect(s, "", want, System.monotonic_time(:millisecond) + 3_000)
    :gen_tcp.close(s)
    statuses
  end

  defp collect(s, acc, want, deadline) do
    statuses = Regex.scan(~r/HTTP\/1\.1 (\d{3})/, acc, capture: :all_but_first) |> List.flatten()
    left = deadline - System.monotonic_time(:millisecond)

    if length(statuses) >= want or left <= 0 do
      statuses
    else
      case :gen_tcp.recv(s, 0, left) do
        {:ok, data} -> collect(s, acc <> data, want, deadline)
        {:error, _} -> statuses
      end
    end
  end

  # the headers, then the body as its own packet
  defp post(path, type, body) do
    [
      "POST #{path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: #{type}\r\n" <>
        "Content-Length: #{byte_size(body)}\r\n\r\n",
      body
    ]
  end

  @me "GET /api/me HTTP/1.1\r\nHost: localhost\r\nCookie: probe=#{String.duplicate("c", 300)}\r\n\r\n"

  test "a CSP report (unparsed type) and the next request share a connection cleanly", %{
    port: port
  } do
    report =
      Jason.encode!(%{
        "csp-report" => %{"effective-directive" => "style-src-elem", "blocked-uri" => "inline"}
      })

    log =
      capture_log(fn ->
        assert exchange(
                 port,
                 post("/api/csp-report", "application/csp-report", report) ++ [@me],
                 2
               ) ==
                 ["204", "200"]
      end)

    refute log =~ "Request line HTTP error"
  end

  test "the new report format (parsed JSON) too", %{port: port} do
    report =
      Jason.encode!([
        %{
          "type" => "csp-violation",
          "body" => %{"effectiveDirective" => "img-src", "blockedURL" => "https://x.example/a"}
        }
      ])

    assert exchange(port, post("/api/csp-report", "application/reports+json", report) ++ [@me], 2) ==
             ["204", "200"]
  end

  test "junk refused (400): the next request still works", %{port: port} do
    assert exchange(
             port,
             post("/api/csp-report", "application/csp-report", "not json") ++ [@me],
             2
           ) ==
             ["400", "200"]
  end

  # crash review 2026-11-13 (HoodrideWeb.BodyGate): a body that isn't JSON
  # was left unread, then READ by Bandit after the answer to reach the next
  # request — up to 8 MB in memory, waiting up to 15 s per piece. Now the
  # answer closes the connection: nothing more is read. Shown here with 1 MB
  # declared and only a sliver sent: the answer, then the close, at once —
  # not a connection held open waiting for the other 999,990 bytes.
  test "a body that isn't JSON is never read to its end: answered, then closed at once", %{
    port: port
  } do
    {:ok, s} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false, nodelay: true])

    :ok =
      :gen_tcp.send(
        s,
        "POST /api/nothing-here HTTP/1.1
Host: localhost
Content-Type: text/plain
" <>
          "Content-Length: 1000000

" <> String.duplicate("x", 10)
      )

    {:ok, answer} = :gen_tcp.recv(s, 0, 3_000)
    assert answer =~ ~r/^HTTP\/1\.1 \d{3}/
    assert answer =~ ~r/connection: close/i
    assert {:error, :closed} = drain_until_closed(s, 1_000)
  end

  defp drain_until_closed(s, ms) do
    case :gen_tcp.recv(s, 0, ms) do
      {:ok, _} -> drain_until_closed(s, ms)
      other -> other
    end
  end
end
