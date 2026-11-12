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

# The rate budgets (requests, photos, chats, live-connection handshakes,
# sign-in starts, refused sign-in codes, Google refreshes) are in
# lib/hoodride/limits.ex with every other limit, and their reasons
# (owner, 2026-11-12: all limits in one place). An environment may switch one
# off here: `config :hoodride, :http_budget, nil` (dev.exs, loadtest.exs).

# A planned restart (HoodrideWeb.RestartNotice): apps reconnect once at a random
# moment in [min_ms, max_ms] (the server is back in ~5 s); flush_ms is the
# pause after telling them, so the pushes leave before the sockets close.
config :hoodride, :restart_notice, min_ms: 4000, max_ms: 10000, flush_ms: 1000

# map updates held per watcher and sent as one frame (WorldChannel); 0 = off.
# 500 ms from the capacity matrix (ARCHITECTURE.md "Capacity"): less than
# half the server work of off at 4,000 people; longer windows saved no more
# CPU but cost memory and delay.
config :hoodride, :map_batch_ms, 500

# Database changes the version before can't run on fail the precommit
# (mix excellent_migrations.check_safety — owner, 2026-11-11): a deploy that
# fails switches back to the version before, which must still read the
# database. Expand, then contract: a column goes in a LATER release than
# the one that stops using it. Kept on: removing, renaming or retyping a
# column; dropping or renaming a table; raw SQL (it could do any of those —
# mark a safe one: # excellent_migrations:safety-assured-for-next-line
# raw_sql_executed). Off: Postgres/MySQL locking and backfill checks, which
# don't apply to SQLite. Changes before the last one already shipped are
# not checked (start_after).
config :excellent_migrations,
  start_after: "20261108154456",
  skip_checks: [
    :check_constraint_added,
    :column_added_with_default,
    :column_reference_added,
    :column_volatile_default,
    :index_concurrently_without_disable_ddl_transaction,
    :index_concurrently_without_disable_migration_lock,
    :index_not_concurrently,
    :json_column_added,
    :many_columns_index,
    :not_null_added,
    :operation_delete,
    :operation_insert,
    :operation_update
  ]

# Import environment specific config. This must remain at the bottom
# of this file so it overrides the configuration defined above.
import_config "#{config_env()}.exs"
