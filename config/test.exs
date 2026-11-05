import Config

# Configure your database
#
# The MIX_TEST_PARTITION environment variable can be used
# to provide built-in test partitioning in CI environment.
# Run `mix help test` for more information.
config :hoodride, Hoodride.Repo,
  database: Path.expand("../hoodride_test.db", __DIR__),
  # SQLite is single-writer: one pooled connection serializes all test DB
  # access and eliminates intermittent "Database busy" under load
  pool_size: 1,
  busy_timeout: 5_000,
  # …and with ONE connection, the many async tests queue for it: the
  # default patience (queue_target 50 ms per 1 s interval) dropped two
  # checkouts on a busy run (2026-10-31: "request was dropped from queue"),
  # and prod's patience (1 s, config/runtime.exs) still dropped three on a
  # loaded machine (2026-11-02: after 2.1–4.9 s — DBConnection drops past
  # twice the target). A test that waits is fine; one dropped fails for
  # nothing: up to ~10 s here (Hoodride.TestDbQueueTest). Tests that need
  # another value set their own (overload_test, reveal_batch_test)
  queue_target: 5_000,
  queue_interval: 10_000,
  pool: Ecto.Adapters.SQL.Sandbox

# We don't run a server during test. If one is required,
# you can enable the server option below.
config :hoodride, HoodrideWeb.Endpoint,
  http: [ip: {127, 0, 0, 1}, port: 4002],
  secret_key_base: "v/NJct3CR71vRve6FxBybPiFIigs1+QzzPC9lZob279k8G2/2uIjyZmx9T1f9Ifz",
  server: false

# Print only warnings and errors during test
config :logger, level: :warning

# Initialize plugs at runtime for faster test compilation
config :phoenix, :plug_init_mode, :runtime

# Sort query params output of verified routes for robust url comparisons
config :phoenix,
  sort_verified_routes_query_params: true

config :hoodride, dev_login: true

# no Sweeper tick: tests sweep on purpose (Hoodride.Sweeper.sweep_now/0)
config :hoodride, :sweep_every_ms, :manual
config :hoodride, :oauth_redirect_from_request, true

# tests: no pause after the restart notice (HoodrideWeb.RestartNotice)
config :hoodride, :restart_notice, min_ms: 4000, max_ms: 10000, flush_ms: 0

# profile photos (Hoodride.Avatars): a folder of their own, and every photo
# request answered 404 unless a test stubs its own (Hoodride.AvatarsOffPlug)
config :hoodride, :avatar_dir, Path.expand("../tmp/test_avatars", __DIR__)
config :hoodride, :avatar_req, plug: Hoodride.AvatarsOffPlug

# map batching off here, so the :per_message tests (one update, one
# message) run; batching itself: map_batch_test.exs, and the whole suite
# with it on via `MAP_BATCH_MS=500 mix test` (test_helper.exs)
config :hoodride, :map_batch_ms, 0

# sign-in limits off by default (many tests start sign-ins from 127.0.0.1);
# HoodrideWeb.SignInRefreshTest and Hoodride.SignInFailuresTest switch them on
config :hoodride, :sign_in_budget, nil
config :hoodride, :sign_in_failures, nil

# every language switched on in tests, the made-up en-XA too (Hoodride.I18n):
# the languages journey checks no English is left through the real loader
config :hoodride, :languages, :all
