# :soak runs for minutes (test/hoodride_web/channels/soak_test.exs):
# opt in with `mix test --only soak`
# :unix_socket needs a real Unix socket — Linux only (Windows: eafnosupport);
# run it in WSL with `mix test --only unix_socket`
# MAP_BATCH_MS=500 mix test: the whole suite with map batching on
# (WorldChannel :map_batch_ms) — TestClient.frames/2 unpacks the batches.
# Skipped then: :per_message tests, which wait for ONE message or check the
# exact sequence batching merges (left + update → the update).
batch_ms = System.get_env("MAP_BATCH_MS")
if batch_ms, do: Application.put_env(:hoodride, :map_batch_ms, String.to_integer(batch_ms))

# assert_receive waits up to 1 s (ExUnit's default: 100 ms). A passing test
# never waits longer — the message ends the wait — but on a busy machine a
# reply can take over 100 ms, and the full-flow test failed on exactly that
# under load (2026-10-28). refute_receive keeps its own 100 ms.
ExUnit.start(
  assert_receive_timeout: 1_000,
  exclude: [:soak, :unix_socket] ++ if(batch_ms, do: [:per_message], else: [])
)

Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, :manual)
