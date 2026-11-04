# This file is responsible for configuring your application
# and its dependencies with the aid of the Config module.
#
# This configuration file is loaded before any dependency and
# is restricted to this project.

# General application configuration
import Config

config :hoodride,
  ecto_repos: [Hoodride.Repo],
  generators: [timestamp_type: :utc_datetime]

# Configure the endpoint
config :hoodride, HoodrideWeb.Endpoint,
  url: [host: "localhost"],
  adapter: Bandit.PhoenixAdapter,
  render_errors: [
    formats: [json: HoodrideWeb.ErrorJSON],
    layout: false
  ],
  pubsub_server: Hoodride.PubSub,
  live_view: [signing_salt: "Z7pykpL4"]

# Configure Elixir's Logger
config :logger, :default_formatter,
  format: "$time $metadata[$level] $message\n",
  metadata: [:request_id]

# Use Jason for JSON parsing in Phoenix
config :phoenix, :json_library, Jason

# Our own JS, minified at deploy (and for the browser journeys) —
# Mix.Tasks.Hoodride.Minify. esbuild without bundling never renames
# top-level names (the files share globals). The browsers: the minimum for
# what our code uses (`??`: Chrome/Edge 80, Firefox 72, Safari 13.1, iOS
# 13.4; esbuild rewrites `?.` for Chrome < 91 and Firefox < 74) — so
# minifying never needs a newer phone than the code itself, and syntax the
# oldest can't run fails the build (bigint: esbuild only warns — made an
# error). Destructuring: esbuild counts it from Safari 14.1 / iOS 14.5 (older
# Safari fails edge-case conformance tests) and can't rewrite it; our code
# already uses it and runs on these phones, so it's declared supported —
# the minified files carry exactly the risk the readable ones do. Source
# maps written beside the files, never linked or served (not in
# HoodrideWeb.static_paths/0).
config :esbuild,
  version: "0.28.2",
  minify: [
    args:
      ~w(--minify --target=es2020,safari13.1,ios13.4,chrome80,edge80,firefox72 --supported:destructuring=true --log-override:bigint=error --sourcemap=external --log-level=warning)
  ]

# Never in a log line, at any level: exact positions (ride "pos", the
# meetup pin) travel as lat/lng; socket tokens (a day-long credential —
# Phoenix logs every socket connect WITH its params at :info, prod's level);
# chat text. Phoenix logs every channel message with its params at :debug —
# on in dev, and one level change away in prod.
config :phoenix, :filter_parameters, ["password", "secret", "lat", "lng", "token", "text"]

# per-address HTTP budget (HoodrideWeb.HttpBudget): opening the app is ~3
# calls; 120 at once covers a café on one IPv4 address, then 1 a second
config :hoodride, :http_budget, per_minute: 60, burst: 120

# profile photos (/avatars/:name) have their OWN budget, per account: a busy
# pile list must not use up what /api/state needs. 2x reveal's (a photo is
# only learned through reveal — 20 names at once, 60 a minute — chat or a
# ride, and each loads once per device): burst 40, 120 a minute
# (test/hoodride_web/avatar_serving_test.exs checks they stay in step)
config :hoodride, :avatar_budget, per_minute: 120, burst: 40

# per-address budget on WebSocket handshakes, before the token is checked
# (HoodrideWeb.UserSocket): the same numbers — a person connects ~once per page
config :hoodride, :ws_budget, per_minute: 60, burst: 120

# Sign-in (HoodrideWeb.AuthController) — the numbers, and where they come from:
#   * starts (/auth/*) have their OWN pool, so sign-in can't eat the app's
#     budget: 30 a minute per address. No standard for password-free sign-in:
#     between Okta's /authorize (60/min) and password-login examples (5–10),
#     generous because a carrier's CGNAT puts many people on one address
#   * codes Google refuses (made-up codes, RFC 6819 §4.4.1.12): 30 in 3
#     minutes block the address for an hour — GitLab's published numbers
#   * "Refresh from Google": 5 at once, then one every 2 minutes (5 per 10
#     minutes) per account — a judgment call
# (Hoodride.RateBudget lets `burst` + 1 through at once: 29 → 30, 4 → 5)
config :hoodride, :sign_in_budget, per_minute: 30, burst: 29
config :hoodride, :sign_in_failures, max: 30, window_ms: 180_000, block_ms: 3_600_000
config :hoodride, :refresh_budget, per_minute: 0.5, burst: 4

# A planned restart (HoodrideWeb.RestartNotice): apps reconnect once at a random
# moment in [min_ms, max_ms] (the server is back in ~5 s); flush_ms is the
# pause after telling them, so the pushes leave before the sockets close.
config :hoodride, :restart_notice, min_ms: 4000, max_ms: 10000, flush_ms: 1000

# map updates held per watcher and sent as one frame (WorldChannel); 0 = off.
# 500 ms from the capacity matrix (ARCHITECTURE.md "Capacity"): less than
# half the server work of off at 4,000 people; longer windows saved no more
# CPU but cost memory and delay.
config :hoodride, :map_batch_ms, 500

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
