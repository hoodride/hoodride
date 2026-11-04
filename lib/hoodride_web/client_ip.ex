defmodule HoodrideWeb.ClientIp do
  @moduledoc """
  The visitor's real address, behind a reverse proxy — for the per-IP
  budget (HoodrideWeb.HttpBudget).

  Behind a proxy every request arrives FROM the proxy, which names the
  visitor in `X-Forwarded-For`. Anyone can send that header, and many
  proxies APPEND to what the client sent ("forged, real"), so the leftmost
  entry is whatever the client typed. Plug.RewriteOn takes the leftmost
  (deps/plug rewrite_on.ex) — a rate limit keyed on it is dodged by
  inventing a new address per request. MDN: only addresses added by YOUR
  trusted proxies may be used for rate limiting, read from the right.

  So: believe the header only when the connection itself is a configured
  proxy (`config :hoodride, :trusted_proxies`, from TRUSTED_PROXIES); join
  every X-Forwarded-For header into one list; walk from the right, skipping
  our proxies; the first other address is the visitor. No proxy configured
  (dev, or a server exposed directly): the header is ignored. Deploy rule
  (MDN): the app must be reachable ONLY through the proxy.
  """
  @behaviour Plug

  require Logger

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    %{conn | remote_ip: client_ip(conn, Application.get_env(:hoodride, :trusted_proxies, []))}
  end

  @doc false
  def client_ip(conn, trusted), do: from_headers(conn.remote_ip, conn.req_headers, trusted)

  @doc """
  The same rule from a peer address and request headers — for the socket,
  which Phoenix dispatches BEFORE the endpoint's plugs (endpoint.ex
  `plug :socket_dispatch`), handing it `peer_data` and `x_headers` instead.
  Cloudflare sets X-Forwarded-For too (equal to CF-Connecting-IP, or
  appended), so this one header serves HTTP and sockets alike.
  """
  def from_headers(remote_ip, headers, trusted) do
    if trusted_peer?(remote_ip, trusted) do
      headers
      |> Enum.filter(fn {name, _} -> String.downcase(name) == "x-forwarded-for" end)
      |> Enum.map(&elem(&1, 1))
      |> Enum.flat_map(&String.split(&1, ","))
      |> Enum.map(&String.trim/1)
      |> Enum.reverse()
      |> walk(trusted, remote_ip)
    else
      remote_ip
    end
  end

  # A Unix-socket connection has no address: Bandit reports {:local, ""}.
  # It's our proxy only when runtime.exs trusts the socket (SOCKET_PATH puts
  # :local in the list) — the socket file's permissions decide who can
  # connect, so nobody outside can arrive this way. An IP list never covers it.
  defp trusted_peer?({:local, _}, trusted), do: :local in trusted
  defp trusted_peer?(ip, trusted), do: ip in trusted

  # right to left: skip our proxies; the first other address is the client;
  # anything unparsable stops the walk at the last address we trust
  defp walk([], _trusted, last), do: last

  defp walk([entry | rest], trusted, last) do
    case :inet.parse_strict_address(String.to_charlist(entry)) do
      {:ok, ip} -> if ip in trusted, do: walk(rest, trusted, ip), else: ip
      {:error, _} -> last
    end
  end

  @doc """
  The budget key for an address: IPv4 per address, IPv6 per /64. A home
  connection gets a whole /64 of IPv6 addresses — keyed per address, a
  client rotates within it and never meets a limit (CVE-2026-45364).
  """
  def budget_key({_, _, _, _} = ip), do: ip
  def budget_key({a, b, c, d, _, _, _, _}), do: {:v6_64, a, b, c, d}

  # No address at all: over the socket without a usable X-Forwarded-For.
  # Cloudflare always sends it, so this is a local `curl` or a broken setup:
  # all such requests share ONE budget (leaving the header out gets nobody
  # past the limit; the app keeps answering). Warned once per boot — a setup
  # that strips the header would otherwise only show as everyone being
  # refused together, once traffic outgrows the one budget.
  def budget_key({:local, _}) do
    unless :persistent_term.get({__MODULE__, :warned}, false) do
      :persistent_term.put({__MODULE__, :warned}, true)

      Logger.warning(
        "request over the Unix socket without a usable X-Forwarded-For: client " <>
          "address unknown, using one shared budget. Is cloudflared in front?"
      )
    end

    :no_address
  end

  @doc false
  def forget_warning, do: :persistent_term.erase({__MODULE__, :warned})
end
