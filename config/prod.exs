import Config

# Force using SSL in production. This also sets the "strict-security-transport" header,
# known as HSTS. If you have a health check endpoint, you may want to exclude it below.
# Note `:force_ssl` is required to be set at compile-time.
config :hoodride, HoodrideWeb.Endpoint,
  force_ssl: [
    rewrite_on: [:x_forwarded_proto],
    exclude: [
      # paths: ["/health"],
      hosts: ["localhost", "127.0.0.1"]
    ]
  ]

# Do not print debug messages in production
config :logger, level: :info

# Explicit, not implicit-by-absence: the dev login backdoor is OFF in prod.
# (It was already off because unset ⇒ nil ⇒ falsy, but a future global
# default must never be able to flip it silently.)
config :hoodride, dev_login: false

# the session cookie only over HTTPS
config :hoodride, secure_cookie: true

# the stamped page and sw.js prepared once at start-up: the running server
# serves exactly the version it started with (HoodrideWeb.PageController)
config :hoodride, prepare_pages_at_boot: true

# no request lines in prod: ordinary use leaves no trace in the logs
# (warnings and errors still log; journald keeps them 14 days)
config :hoodride, :request_log, false

# Google's redirect URI from the configured public URL (Endpoint.url), never
# the request — behind an HTTPS proxy the request says http://…:4000
config :hoodride, :oauth_redirect_from_request, false

# Runtime production configuration, including reading
# of environment variables, is done on config/runtime.exs.

# the full Content-Security-Policy is ENFORCED (HoodrideWeb.CSP) — owner's
# call, 2026-10-28: no users but the owner yet, so the report-only wait
# protected nobody. Blocks are still reported to /api/csp-report
# (`journalctl -u hoodride | grep csp:`). To go back to report-only for a
# risky change: `config :hoodride, csp_report_only: true`.
