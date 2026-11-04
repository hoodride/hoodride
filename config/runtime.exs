import Config

# config/runtime.exs is executed for all environments, including
# during releases. It is executed after compilation and before the
# system starts, so it is typically used to load production configuration
# and secrets from environment variables or elsewhere. Do not define
# any compile-time configuration in here, as it won't be applied.
# The block below contains prod specific runtime configuration.

# ## Using releases
#
# If you use `mix release`, you need to explicitly enable the server
# by passing the PHX_SERVER=true when you start it:
#
#     PHX_SERVER=true bin/hoodride start
#
# Alternatively, you can use `mix phx.gen.release` to generate a `bin/server`
# script that automatically sets the env var above.
if System.get_env("PHX_SERVER") do
  config :hoodride, HoodrideWeb.Endpoint, server: true
end

config :hoodride, HoodrideWeb.Endpoint,
  http: [port: String.to_integer(System.get_env("PORT", "4000"))]

# (:loadtest is the prod build for the capacity test: config/loadtest.exs)
if config_env() in [:prod, :loadtest] do
  database_path =
    System.get_env("DATABASE_PATH") ||
      raise """
      environment variable DATABASE_PATH is missing.
      For example: /etc/hoodride/hoodride.db
      """

  # The pool: 5 (ecto_sqlite3's default; cores × 2 + 1 for a 2-core server
  # — HikariCP's "About Pool Sizing": small pools are faster; SQLite runs
  # one write at a time anyway). A BURST may wait rather than fail:
  # DBConnection drops requests only once even its fastest checkouts have
  # waited over queue_target for a whole queue_interval (2 s), and then only
  # those waiting over 2 × queue_target (connection_pool.ex) — at the
  # default 50 ms a sign-in rush got HTTP 500s. busy_timeout: a write that
  # meets another write waits up to 5 s for its turn (default 2 s).
  config :hoodride, Hoodride.Repo,
    database: database_path,
    pool_size: String.to_integer(System.get_env("POOL_SIZE") || "5"),
    queue_target: 1000,
    busy_timeout: 5000

  # profile photos (Hoodride.Avatars) live next to the database — in prod
  # /var/lib/hoodride/avatars, inside systemd's StateDirectory (writable
  # under ProtectSystem=strict, private to the hoodride user)
  config :hoodride, :avatar_dir, Path.join(Path.dirname(database_path), "avatars")

  # The secret key base is used to sign/encrypt cookies and other secrets.
  # A default value is used in config/dev.exs and config/test.exs but you
  # want to use a different value for prod and you most likely don't want
  # to check this value into version control, so we use an environment
  # variable instead.
  secret_key_base =
    System.get_env("SECRET_KEY_BASE") ||
      raise """
      environment variable SECRET_KEY_BASE is missing.
      You can generate one by calling: mix phx.gen.secret
      """

  host = System.get_env("PHX_HOST") || "example.com"

  bind_ip =
    case :inet.parse_strict_address(String.to_charlist(System.get_env("BIND_IP", "127.0.0.1"))) do
      {:ok, ip} -> ip
      _ -> raise "BIND_IP is not an IP address"
    end

  # the reverse proxy's address(es), comma-separated (e.g. "127.0.0.1"): only
  # requests FROM these have their X-Forwarded-For believed (HoodrideWeb.ClientIp)
  trusted_proxies =
    (System.get_env("TRUSTED_PROXIES") || "")
    |> String.split(",", trim: true)
    |> Enum.map(fn ip ->
      case :inet.parse_strict_address(String.to_charlist(String.trim(ip))) do
        {:ok, addr} -> addr
        _ -> raise "TRUSTED_PROXIES: #{inspect(ip)} is not an IP address"
      end
    end)

  # SOCKET_PATH (e.g. /run/hoodride/app.sock): listen on a Unix socket instead
  # of BIND_IP — cloudflared reaches it with `service: unix:<path>`. No port
  # per connection (127.0.0.1 caps at the ~28k temporary ports), and only who
  # the file's permissions allow can connect. Socket connections are then our
  # proxy (:local, HoodrideWeb.ClientIp): one setting, so "socket on, trust
  # forgotten" can't happen.
  socket_path = System.get_env("SOCKET_PATH")

  listen =
    if socket_path,
      do: [ip: {:local, socket_path}, port: 0],
      else: [ip: bind_ip]

  trusted_proxies = if socket_path, do: [:local | trusted_proxies], else: trusted_proxies

  config :hoodride, :trusted_proxies, trusted_proxies

  # Google sign-in (see GOOGLE_SETUP.md)
  config :hoodride, :google_client_id, System.get_env("GOOGLE_CLIENT_ID")
  config :hoodride, :google_client_secret, System.get_env("GOOGLE_CLIENT_SECRET")

  # Facebook sign-in (GOOGLE_SETUP.md, Facebook): its button shows only once set
  config :hoodride, :facebook_app_id, System.get_env("FACEBOOK_APP_ID")
  config :hoodride, :facebook_app_secret, System.get_env("FACEBOOK_APP_SECRET")

  config :hoodride, :dns_cluster_query, System.get_env("DNS_CLUSTER_QUERY")

  # map updates held per watcher and sent as one frame (WorldChannel);
  # unset = config.exs (500 ms; 0 = off). The capacity matrix sets it per run.
  if batch_ms = System.get_env("MAP_BATCH_MS"),
    do: config(:hoodride, :map_batch_ms, String.to_integer(batch_ms))

  # MAP_ENCODE_ONCE=0: channels re-encode every update (only to measure against)
  if System.get_env("MAP_ENCODE_ONCE") == "0", do: config(:hoodride, :map_encode_once, false)

  config :hoodride, HoodrideWeb.Endpoint,
    url: [host: host, port: 443, scheme: "https"],
    # 127.0.0.1 by default: behind a Cloudflare Tunnel (or Caddy on the same
    # box) the app must be reachable ONLY through it — reachable directly,
    # X-Forwarded-For can't be trusted at all (MDN). BIND_IP overrides;
    # SOCKET_PATH replaces both (above).
    http: listen,
    secret_key_base: secret_key_base

  # ## SSL Support
  #
  # To get SSL working, you will need to add the `https` key
  # to your endpoint configuration:
  #
  #     config :hoodride, HoodrideWeb.Endpoint,
  #       https: [
  #         ...,
  #         port: 443,
  #         cipher_suite: :strong,
  #         keyfile: System.get_env("SOME_APP_SSL_KEY_PATH"),
  #         certfile: System.get_env("SOME_APP_SSL_CERT_PATH")
  #       ]
  #
  # The `cipher_suite` is set to `:strong` to support only the
  # latest and more secure SSL ciphers. This means old browsers
  # and clients may not be supported. You can set it to
  # `:compatible` for wider support.
  #
  # `:keyfile` and `:certfile` expect an absolute path to the key
  # and cert in disk or a relative path inside priv, for example
  # "priv/ssl/server.key". For all supported SSL configuration
  # options, see https://plug.hexdocs.pm/Plug.SSL.html#configure/1
  #
  # We also recommend setting `force_ssl` in your config/prod.exs,
  # ensuring no data is ever sent via http, always redirecting to https:
  #
  #     config :hoodride, HoodrideWeb.Endpoint,
  #       force_ssl: [hsts: true]
  #
  # Check `Plug.SSL` for all available options in `force_ssl`.
end
