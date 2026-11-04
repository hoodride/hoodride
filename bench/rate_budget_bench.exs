# What a per-USER rate budget (Hoodride.RateBudget: a shared ETS row,
# insert_new first, then a compare-and-swap) costs per spend, next to what
# it replaced (the same GCRA on the channel's own assigns: no table at all)
# and next to the work a spend sits beside (decoding + handling an inbound
# event: here, JSON-decoding a typical driver_update frame).
#
#   - one process spending on its own row (the common case: one user, one
#     socket), on the allowed path and on the refused path
#   - 8 processes spending on ONE user's row at once (worst contention:
#     the compare-and-swap retries) and on 8 different rows
#
# Interleaved repeats, median reported (background load swings single runs).
#
# Run: $env:MIX_ENV="test"; mix run bench/rate_budget_bench.exs

alias Hoodride.RateBudget

Hoodride.TestHelpers.scrub_live_state()

n = 200_000

# the old way, verbatim: GCRA on a map (the channel's assigns)
old_allow = fn assigns, per_minute, burst, now ->
  interval = 60_000 / per_minute
  tolerance = burst * interval
  tat = assigns[:lane] || now
  new_tat = max(tat, now) + interval
  if new_tat - now > tolerance + interval, do: {:deny, assigns}, else: {:ok, Map.put(assigns, :lane, new_tat)}
end

frame =
  ~s|["4","12","user:4591747035198261","driver_update",{"cell":"882a1072c7fffff","spot":"892a1072c67ffff","parents":["872a1072cffffff","852a1073fffffff"]}]|

per_op = fn fun ->
  {us, _} = :timer.tc(fn -> Enum.each(1..n, fn i -> fun.(i) end) end)
  us * 1000 / n
end

# allowed path: a budget so large it never runs out (every spend swaps)
huge = 60_000_000

cases = [
  {"(loop overhead: an empty op)", fn i -> rem(i, 1000) end},
  {"OLD: GCRA on the channel's assigns (allowed)",
   fn i -> old_allow.(%{lane: i * 1.0}, huge, 1_000_000, i) end},
  {"NEW: RateBudget.spend, own row, allowed (swap)",
   fn i -> RateBudget.spend(1, :bench_ok, huge, 1_000_000, i) end},
  {"NEW: RateBudget.spend, own row, refused",
   fn _ -> RateBudget.spend(2, :bench_deny, 1, 0, 0) end},
  {"JSON-decode an inbound driver_update frame", fn _ -> Jason.decode!(frame) end}
]

rounds = 5

results =
  for _ <- 1..rounds, {name, fun} <- cases, reduce: %{} do
    acc -> Map.update(acc, name, [per_op.(fun)], &[per_op.(fun) | &1])
  end

median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end

IO.puts("\nper spend, one process (median of #{rounds} interleaved rounds × #{n} ops):\n")

for {name, _} <- cases do
  IO.puts("  #{String.pad_trailing(name, 52)} #{Float.round(median.(results[name]), 1)} ns")
end

# ---- contention: 8 processes at once, on one row vs on 8 rows ----
parallel = fn key_of ->
  parent = self()
  per = div(n, 8)

  pids =
    for p <- 1..8 do
      spawn_link(fn ->
        receive do: (:go -> :ok)
        for i <- 1..per, do: RateBudget.spend(key_of.(p), :bench_par, huge, 1_000_000, i)
        send(parent, :done)
      end)
    end

  {us, _} =
    :timer.tc(fn ->
      Enum.each(pids, &send(&1, :go))
      for _ <- pids, do: receive(do: (:done -> :ok))
    end)

  us * 1000 / (per * 8)
end

shared = for(_ <- 1..rounds, do: parallel.(fn _ -> 42 end)) |> median.()
spread = for(_ <- 1..rounds, do: parallel.(fn p -> 100 + p end)) |> median.()

IO.puts("\n8 processes spending at once (wall time per spend, median of #{rounds}):\n")
IO.puts("  #{String.pad_trailing("all on ONE user's row (worst contention)", 52)} #{Float.round(shared, 1)} ns")
IO.puts("  #{String.pad_trailing("each on its own row", 52)} #{Float.round(spread, 1)} ns")

new = median.(results["NEW: RateBudget.spend, own row, allowed (swap)"])
old = median.(results["OLD: GCRA on the channel's assigns (allowed)"])
decode = median.(results["JSON-decode an inbound driver_update frame"])

IO.puts(
  "\n  a per-user spend costs #{Float.round(new - old, 1)} ns more than the old in-process one: " <>
    "#{Float.round(100 * (new - old) / decode, 1)}% of just decoding the event it guards"
)
