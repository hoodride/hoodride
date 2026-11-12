defmodule HoodrideWeb.CspReportController do
  @moduledoc """
  POST /api/csp-report: browsers report what the Content-Security-Policy
  blocked (or, in report-only, would have) — HoodrideWeb.CSP. How we learn,
  before enforcing, whether the policy would break something real.

  Logged as ONE warning line, the rule and the SITE only ("csp: connect-src
  blocked https://evil.example") — never the page, path or query, which can
  carry personal details; no address either. Both formats: the old
  `{"csp-report": {...}}` (report-uri) and the new list (report-to). Junk is
  refused quietly; the API's per-address budget limits floods.

  OFF by default (HoodrideWeb.CSP.reporting?/0, owner 2026-10-29): then this
  is like any unknown API path — 404, nothing read, nothing logged.
  """
  use HoodrideWeb, :controller

  require Logger

  @max_bytes Hoodride.Limits.csp_report_bytes()
  @kinds ~w(inline eval wasm-eval data blob self trusted-types-policy trusted-types-sink)

  def create(conn, params) do
    if HoodrideWeb.CSP.reporting?(),
      do: receive_reports(conn),
      else: HoodrideWeb.AuthController.not_found(conn, params)
  end

  defp receive_reports(conn) do
    # answer on the conn the body was read through: the one from BEFORE the
    # read still says "unread", and Bandit then drains it from the
    # connection — eating the start of the next request cloudflared sends on
    # it (keepalive_test.exs; deploy day, 2026-10-29)
    {conn, result} = reports(conn)

    case result do
      {:ok, reports} ->
        Enum.each(reports, &log/1)
        send_resp(conn, 204, "")

      :too_big ->
        send_resp(conn, 413, "")

      :error ->
        send_resp(conn, 400, "")
    end
  end

  # the new format's type (…+json) is already parsed by Plug.Parsers;
  # application/csp-report arrives unread (body_params: an Unfetched struct)
  defp reports(%Plug.Conn{body_params: %{"_json" => list}} = conn) when is_list(list),
    do: {conn, {:ok, list}}

  defp reports(%Plug.Conn{body_params: params} = conn)
       when not is_struct(params) and map_size(params) > 0,
       do: {conn, {:ok, [params]}}

  defp reports(conn) do
    case Plug.Conn.read_body(conn, length: @max_bytes) do
      {:ok, body, conn} ->
        case Jason.decode(body) do
          {:ok, list} when is_list(list) -> {conn, {:ok, list}}
          {:ok, map} when is_map(map) -> {conn, {:ok, [map]}}
          _ -> {conn, :error}
        end

      # more than the limit: the rest is left — Bandit drains it (or closes)
      {:more, _, conn} ->
        {conn, :too_big}

      {:error, _} ->
        {conn, :error}
    end
  end

  defp log(%{"csp-report" => r}) when is_map(r),
    do: log(r["effective-directive"] || r["violated-directive"], r["blocked-uri"])

  defp log(%{"body" => b}) when is_map(b), do: log(b["effectiveDirective"], b["blockedURL"])
  defp log(_), do: :ok

  defp log(directive, blocked) do
    with d when is_binary(d) <- directive,
         [rule] <- Regex.run(~r/\A[a-z-]{1,40}/, d) do
      Logger.warning("csp: #{rule} blocked #{site(blocked)}")
    end

    :ok
  end

  # the site only — "https://evil.example", or the kind ("inline", "eval")
  defp site(b) when b in @kinds, do: b

  defp site(b) when is_binary(b) do
    case URI.parse(b) do
      %URI{scheme: s, host: h, port: p} when is_binary(s) and is_binary(h) and h != "" ->
        if p in [nil, URI.default_port(s)], do: "#{s}://#{h}", else: "#{s}://#{h}:#{p}"

      %URI{scheme: s} when s in ["data", "blob"] ->
        s

      _ ->
        "other"
    end
  end

  defp site(_), do: "other"
end
