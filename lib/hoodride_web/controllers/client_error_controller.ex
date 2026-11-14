defmodule HoodrideWeb.ClientErrorController do
  @moduledoc """
  POST /api/client-error: the app's error reports (priv/static/errors.js;
  owner, 2026-11-10) — WHAT broke, never who. Logged as ONE warning line:

      client error: TypeError: x is undefined at app.js:1:2 nearby.js:3:4 where=chat build=… browser=…

  (deploy/errors.sh groups them.) Everything is checked again here — a
  modified app could send anything: only the known fields, each capped and
  shaped; the message scrubbed with the app's own rules (links, emails,
  numbers of 2+ digits: ids, positions, phone numbers) and kept on one line
  (no forged second log line); junk refused. The API's per-address budget
  (HoodrideWeb.HttpBudget) limits floods; the app itself sends at most 5 a
  minute, 30 a session. Changes nothing: like /api/csp-report, not checked
  by :own_pages.
  """
  use HoodrideWeb, :controller

  require Logger

  @max_message Hoodride.Limits.error_report_chars()
  # scrubbed: at most this much of the message (abuse review, 2026-11-12:
  # the patterns ran on all of it — up to 64 KB, no sign-in needed — and
  # 64 KB of letters took 18 s of CPU in the email pattern). Enough for the
  # 200 kept after links shrink to <link>
  @scrub_window Hoodride.Limits.error_scrub_chars()
  @where ~w(map chat ride settings search start sync other)

  def create(conn, %{"kind" => kind, "message" => message} = params)
      when is_binary(kind) and is_binary(message) do
    line =
      "client error: #{word(kind, 40, "Error")}: #{scrub(message)}" <>
        " at #{places(params["at"])}" <>
        " where=#{where(params["where"])} build=#{word(params["build"], 40, "?")}" <>
        " browser=#{word(params["browser"], 40, "?")}"

    # at most `cap` logged a minute IN ALL (a flood — one address, or the
    # thousands an IPv6 host has — never drowns the real errors or fills the
    # disk), then ONE line saying the rest of the minute is dropped. The
    # reply is the same either way: a sender learns nothing.
    cap =
      Application.get_env(
        :hoodride,
        :client_error_cap,
        Hoodride.Limits.error_reports_per_minute()
      )

    # each address first gets a few (as many as the app ever sends a
    # minute: Limits.app_error_reports_per_minute): one address
    # could fill the whole minute's cap and drop everyone else's real
    # reports (crash review 2026-11-14) — past its few, dropped silently.
    # (the counters' table gone for a moment: counted as the first —
    # Hoodride.RateLimit.guarded)
    if own_share?(conn) do
      log_capped(line, cap)
    end

    send_resp(conn, 204, "")
  end

  def create(conn, _params), do: send_resp(conn, 400, "")

  @per_address Hoodride.Limits.app_error_reports_per_minute()

  defp own_share?(conn) do
    key = {:client_err, HoodrideWeb.ClientIp.budget_key(conn.remote_ip)}
    match?({:ok, _}, Hoodride.RateBudget.spend(key, :client_err, @per_address, @per_address))
  end

  defp log_capped(line, cap) do
    case Hoodride.RateLimit.guarded(fn -> Hoodride.RateLimit.inc(:client_errors, 60_000) end, 1) do
      n when n <= cap ->
        Logger.warning(line)
        :telemetry.execute([:hoodride, :client_error], %{count: 1}, %{line: line})

      n when n == cap + 1 ->
        Logger.warning("client error: over #{cap} a minute — the rest of this minute dropped")

      _ ->
        :ok
    end
  end

  @doc false
  # the app's rules (errors.js scrub), again: links, emails, numbers of 2+
  # digits out; one line; capped
  def scrub(text) do
    text
    |> window()
    |> String.replace(~r/\b(?:https?|wss?):\/\/\S+/i, "<link>")
    |> String.replace(~r/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/u, "<email>")
    # a number of 2+ digits (with its . - ( ) and spaces): small account ids
    # are 1–3 digits; a lone digit stays
    |> String.replace(~r/\d[\d.\-() ]*\d/, "<n>")
    |> String.replace(~r/[\x00-\x1f\x7f]+/, " ")
    |> String.slice(0, @max_message)
  end

  # the first @scrub_window characters; when that cuts the message, its last
  # word goes too — it may be half an email or link, which no longer looks
  # like one and would be logged as text (emails and links have no spaces,
  # so a cut one is dropped whole)
  defp window(text) do
    if String.length(text) <= @scrub_window do
      text
    else
      cut = String.slice(text, 0, @scrub_window)
      String.replace(cut, ~r/\S+\z/u, "")
    end
  end

  # "file.js:line:col", up to 3 — nothing else
  defp places(list) when is_list(list) do
    list
    |> Enum.filter(
      &(is_binary(&1) and Regex.match?(~r/\A[\w.-]{1,60}\.js:\d{1,7}:\d{1,7}\z/, &1))
    )
    |> Enum.take(3)
    |> Enum.join(" ")
  end

  defp places(_), do: ""

  defp where(w) when w in @where, do: w
  defp where(_), do: "other"

  # a short plain word (letters, digits, / . _ -), else the fallback
  defp word(v, max, fallback) when is_binary(v) do
    if byte_size(v) in 1..max and Regex.match?(~r/\A[\w\/.-]+\z/, v), do: v, else: fallback
  end

  defp word(_, _, fallback), do: fallback
end
