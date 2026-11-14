defmodule Hoodride.Application do
  # See https://elixir.hexdocs.pm/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    Hoodride.Geo.init_tables()
    Hoodride.Chat.init_tables()
    Hoodride.Requests.init_tables()
    Hoodride.Rides.init_tables()
    Hoodride.RateBudget.init_table()
    Hoodride.SignInFailures.init_table()
    HoodrideWeb.UserSocket.init_table()
    Hoodride.SessionStamp.init_table()
    Hoodride.SessionTokens.init_table()
    # the build is fixed at boot: files edited later are the NEXT build
    HoodrideWeb.Build.current()
    # prod: the stamped page and sw.js too, once (HoodrideWeb.PageController.prepare/1)
    if Application.get_env(:hoodride, :prepare_pages_at_boot, false),
      do: HoodrideWeb.PageController.prepare()

    # SOCKET_PATH: clear a socket file left by a stopped run (HoodrideWeb.SocketFile)
    if path =
         HoodrideWeb.SocketFile.listen_path(Application.get_env(:hoodride, HoodrideWeb.Endpoint)),
       do: HoodrideWeb.SocketFile.prepare(path)

    children = [
      HoodrideWeb.Telemetry,
      Hoodride.Repo,
      {Ecto.Migrator,
       repos: Application.fetch_env!(:hoodride, :ecto_repos), skip: skip_migrations?()},
      # can THIS version read the database as it now is? If not, it refuses
      # to start — a deploy switching back onto a newer version's database
      # changes fails its check loudly instead of failing every sign-in
      Hoodride.SchemaCheck,
      # the sign-ins (Hoodride.SessionTokens), loaded before the web server
      # starts (it blocks: no connection is accepted before the list is
      # there) — every request and connect checks them in memory
      Hoodride.SessionTokens,
      # profile photos: the folder exists, files nothing points to removed
      Hoodride.Avatars,
      {DNSCluster, query: Application.get_env(:hoodride, :dns_cluster_query) || :ignore},
      # Subscriptions grouped by TOPIC (Elixir 1.19+ key-partitioned Registry):
      # a cell's watchers sit together in one sorted (CA-tree) table, so
      # leaving a crowded cell stays O(log n) instead of scanning the cell's
      # watchers, and busy cells' locks can split. Chosen for predictable
      # behaviour as users concentrate in cells; the default below measured
      # faster for sparse cells on small servers (bench/pubsub_stress_bench.exs).
      # To switch back, swap these two lines — no data to migrate, takes
      # effect on restart.
      # {Phoenix.PubSub, name: Hoodride.PubSub},
      {Phoenix.PubSub, name: Hoodride.PubSub, group_by: :key},
      {Registry, keys: :unique, name: Hoodride.Rides.Registry},
      # live user-channel directory: presence is DERIVED from this (crash-proof
      # — dead processes vanish automatically), never from last-event claims
      {Registry, keys: :duplicate, name: Hoodride.UserChannels},
      # live map channels: user_id → transport pid. Newest wins (one per
      # account), and the user channel on the same socket finds its own map
      # here to ask "is this person on my screen?" before a cold contact
      {Registry, keys: :duplicate, name: Hoodride.WorldChannels},
      # live sockets: user_id → the stamp of the tab behind each (who gets
      # in on an automatic reconnect: Hoodride.SessionStamp)
      {Registry, keys: :duplicate, name: Hoodride.SocketStamps},
      # rides look up a name they started without HERE, never in the ride
      # itself (a slow database froze it: Hoodride.RideBusyTest)
      {Task.Supervisor, name: Hoodride.Rides.Lookups},
      {DynamicSupervisor, strategy: :one_for_one, name: Hoodride.Rides.Supervisor},
      # one supervisor for ALL the map writers: its restart allowance is
      # theirs together — the default 3 in 5 s let a few writer crashes in
      # a row give up and soon restart the whole app (supervision review,
      # 2026-11-13; Hoodride.HardeningTest). A real crash loop still stops.
      {PartitionSupervisor,
       child_spec: Hoodride.GeoWriter, name: Hoodride.GeoWriters, max_restarts: 50, max_seconds: 5},
      # shared per-user rate counters (Hoodride.Throttle); cleans itself
      {Hoodride.RateLimit, clean_period: :timer.minutes(1)},
      Hoodride.Sweeper,
      # Start to serve requests, typically the last entry
      HoodrideWeb.Endpoint
    ]

    # See https://elixir.hexdocs.pm/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Hoodride.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # A polite stop (SIGTERM — systemctl restart, deploy.sh): before anything
  # shuts down, tell every connected app it's a planned restart, so it
  # reconnects promptly instead of backing off (HoodrideWeb.RestartNotice).
  @impl true
  def prep_stop(state) do
    HoodrideWeb.RestartNotice.announce()
    state
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    HoodrideWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  defp skip_migrations?() do
    # By default, sqlite migrations are run when using a release
    System.get_env("RELEASE_NAME") == nil
  end
end
