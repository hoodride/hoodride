# What the privacy fix's live role check costs per forwarded map message,
# measured next to the work every forwarded message already does.
#
# The WorldChannel now calls Hoodride.Roles.of/1 (two :ets.member lookups)
# before pushing each broadcast. Compared with: encoding the message (the
# transport serializes every push to JSON) and the message send itself.
# Tables are filled to a big-town scale: 50k drivers on the map, 10k users
# in rides. Interleaved repeats, median reported (background load swings
# single runs, see the sweeper benches).
#
# Run: $env:MIX_ENV="test"; mix run bench/role_check_bench.exs

alias Hoodride.Roles

Hoodride.TestHelpers.scrub_live_state()

for id <- 1..50_000,
    do: :ets.insert(:geo_drivers, {id, "c", "c", 0})

for id <- 100_001..110_000, do: :ets.insert(:rides_by_user, {id, "r#{id}"})

n = 1_000_000

payload = %{id: 4_591_747_035_198_261, lat: 40.7154, lng: -74.0086, name: "FxCar-Pv", photo: nil}

msg = %Phoenix.Socket.Message{
  topic: "world",
  event: "driver_update",
  payload: payload,
  ref: nil,
  join_ref: "4"
}

per_op = fn fun ->
  {us, _} = :timer.tc(fn -> Enum.each(1..n, fn i -> fun.(i) end) end)
  us * 1000 / n
end

cases = [
  # baselines: what the loop itself costs, and ONE bare lookup
  {"(loop overhead: an empty op)", fn i -> rem(i, 1000) end},
  {"(one bare :ets.member on geo_drivers)", fn i -> :ets.member(:geo_drivers, rem(i, 50_000)) end},
  {"Roles.of: a viewer (in neither table)", fn i -> Roles.of(200_000 + rem(i, 1000)) end},
  {"Roles.of: a driver (car row found)", fn i -> Roles.of(1 + rem(i, 50_000)) end},
  {"Roles.of: in a ride (first lookup hits)", fn i -> Roles.of(100_001 + rem(i, 10_000)) end},
  {"JSON-encode the pushed message (V2 serializer)",
   fn _ -> Phoenix.Socket.V2.JSONSerializer.encode!(msg) end},
  {"send + receive the message (process hop)",
   fn _ ->
     send(self(), msg)

     receive do
       ^msg -> :ok
     end
   end}
]

rounds = 5

results =
  for _ <- 1..rounds, {name, fun} <- cases, reduce: %{} do
    acc -> Map.update(acc, name, [per_op.(fun)], &[per_op.(fun) | &1])
  end

median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end

IO.puts("\nper forwarded map message (median of #{rounds} interleaved rounds × #{n} ops):\n")

for {name, _} <- cases do
  IO.puts("  #{String.pad_trailing(name, 50)} #{Float.round(median.(results[name]), 1)} ns")
end

check = median.(results["Roles.of: a driver (car row found)"])
encode = median.(results["JSON-encode the pushed message (V2 serializer)"])
hop = median.(results["send + receive the message (process hop)"])

IO.puts(
  "\n  the check adds #{Float.round(100 * check / (encode + hop), 1)}% to the per-message " <>
    "work it sits next to (encode + hop = #{Float.round(encode + hop, 1)} ns)"
)
