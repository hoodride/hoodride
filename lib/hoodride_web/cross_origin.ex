defmodule HoodrideWeb.CrossOrigin do
  @moduledoc """
  Requests that change something (sign out, delete the account, agree to the
  Terms, save the car, dev login) must come from Hood Ride's own pages — the
  rule of Go's standard library (net/http CrossOriginProtection, which
  OWASP's CSRF guidance points to), 2026-11-08:

    1. reading (GET, HEAD, OPTIONS): not checked;
    2. the browser says where the request comes from (`Sec-Fetch-Site`):
       only `same-origin` or `none` (typed by the person) — another site,
       a subdomain too (`same-site`), is refused;
    3. no such signal but an `Origin`: it must be this very address — scheme,
       host and port of the request itself (so it holds on hoodride.app and
       on a phone on home Wi-Fi alike); `null`, anything malformed, or a
       header sent twice: refused;
    4. neither: allowed — not a modern browser, so not a page another site
       could use (scripts, tests, very old browsers: the SameSite cookie).

  Before, only the cookie's SameSite setting stood between another site and
  these requests. Refused: 403 `cross_site`, a warning line naming only the
  kind (never an address), and a telemetry event (the browser journey
  counts them).
  """
  @behaviour Plug

  import Plug.Conn
  require Logger

  @reading ~w(GET HEAD OPTIONS)

  @impl true
  def init(opts), do: opts

  @impl true
  def call(%Plug.Conn{method: method} = conn, _opts) when method in @reading, do: conn

  def call(conn, _opts) do
    case verdict(conn) do
      :ok ->
        conn

      {:refuse, kind} ->
        Logger.warning("cross-site request refused: #{kind}")
        :telemetry.execute([:hoodride, :cross_origin, :refused], %{count: 1}, %{kind: kind})

        conn
        |> put_status(403)
        |> Phoenix.Controller.json(%{error: "cross_site"})
        |> halt()
    end
  end

  @doc false
  # → :ok | {:refuse, kind}
  def verdict(conn) do
    case get_req_header(conn, "sec-fetch-site") do
      [site] when site in ["same-origin", "none"] -> :ok
      [] -> origin_verdict(conn)
      [_] -> {:refuse, "another site"}
      _ -> {:refuse, "repeated header"}
    end
  end

  defp origin_verdict(conn) do
    case get_req_header(conn, "origin") do
      [] -> :ok
      [origin] -> if same_origin?(origin, conn), do: :ok, else: {:refuse, "another origin"}
      _ -> {:refuse, "repeated header"}
    end
  end

  # the Origin's scheme, host and port are the request's own (an IPv6 host
  # keeps its brackets in the request, not in the parsed Origin)
  defp same_origin?(origin, conn) do
    case URI.parse(origin) do
      %URI{scheme: scheme, host: host, port: port, userinfo: nil, path: path, query: nil}
      when scheme in ["http", "https"] and is_binary(host) and host != "" and path in [nil, ""] ->
        scheme == Atom.to_string(conn.scheme) and
          String.downcase(host) == own_host(conn) and port == conn.port

      _ ->
        false
    end
  end

  defp own_host(conn),
    do: conn.host |> String.trim_leading("[") |> String.trim_trailing("]") |> String.downcase()
end
