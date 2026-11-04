import Config

# The capacity test (ARCHITECTURE.md): the PROD build, with simulated people.
# Build with `MIX_ENV=loadtest mix release`; never deploy it. Differs from
# prod in exactly these (a test holds that):
import_config "prod.exs"

# simulated people sign in by name — still local-only (loopback, a local
# host, no forwarding headers: AuthController.local_request?)
config :hoodride, dev_login: true

# they all come from one address: no per-IP budgets (as in dev)
config :hoodride, :http_budget, nil
config :hoodride, :ws_budget, nil
config :hoodride, :sign_in_budget, nil
config :hoodride, :sign_in_failures, nil
