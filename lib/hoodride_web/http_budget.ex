defmodule HoodrideWeb.HttpBudget do
  @moduledoc """
  A budget for the HTTP endpoints (`/api/*`, `/auth/*`) — the same
  Hoodride.RateBudget as the socket budgets (a burst, then a steady rate,
  the exact wait) — keyed by the ACCOUNT when signed in, by the address
  (HoodrideWeb.ClientIp.budget_key/1: IPv4, or IPv6 per /64) when not.
  Many people share one address (a carrier's CGNAT, a café's Wi-Fi): signed
  in, each has their own budget. Before sign-in (`/auth/*`, a signed-out
  call) the address is all there is — and those calls are rare.

  Sized from the app: opening it is ~3 calls (state, socket token, a
  token refresh on reconnect); a household or a café on one IPv4 address
  must fit whole. Over: 429 with Retry-After (RFC 6585) and `retry_ms`.
  `config :hoodride, :http_budget, per_minute: …, burst: …`; nil = off (dev,
  where the monster runs hundreds of people from one address).
  """
  @behaviour Plug

  import Plug.Conn

  # `config:` which limits (config key), `name:` which bucket — profile
  # photos have their own (`:avatar_budget`), so a busy pile list can't use
  # up what /api/state needs
  @impl true
  def init(opts), do: Keyword.merge([config: :http_budget, name: :http], opts)

  @impl true
  def call(conn, opts) do
    case Hoodride.Limits.budget(opts[:config]) do
      nil -> conn
      limits -> check(conn, limits[:per_minute], limits[:burst], opts[:name])
    end
  end

  defp check(conn, per_minute, burst, name) do
    key =
      case conn.assigns[:current_user] do
        %{id: id} -> {:http_user, id}
        _ -> {:http, HoodrideWeb.ClientIp.budget_key(conn.remote_ip)}
      end

    case Hoodride.RateBudget.spend(key, name, per_minute, burst) do
      {:ok, _} ->
        conn

      {:deny, _} ->
        wait = max(Hoodride.RateBudget.wait_ms(key, name, per_minute, burst), 1)

        conn
        |> put_resp_header("retry-after", Integer.to_string(div(wait + 999, 1000)))
        |> put_resp_header("cache-control", "no-store")
        |> put_resp_content_type("application/json")
        |> send_resp(429, Jason.encode!(%{error: "rate_limited", retry_ms: wait}))
        |> halt()
    end
  end
end
