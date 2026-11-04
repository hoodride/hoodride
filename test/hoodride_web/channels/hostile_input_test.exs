defmodule HoodrideWeb.HostileInputTest do
  @moduledoc """
  The new surfaces (reveal, the role-filtered sync, the cold-contact rule)
  fed garbage and lies by a hostile client. Two laws: never a crash (the
  channel stays alive and answers), never a leak (no hand reaches a viewer,
  nothing probes who exists).
  """
  use ExUnit.Case

  alias Hoodride.{Geo, TestClient}
  import TestClient, only: [frames: 1, request: 4]

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    u
  end

  @garbage_ids [-1, 0, 1.5, 2 ** 70, -(2 ** 70), "12", "", nil, [], %{}, true, "abc"]

  test "reveal: any garbage id is the same refusal, and the channel lives on" do
    hand = user("hi-hand")
    Geo.hand_up(hand.id, "hcell", "s")
    d = user("hi-d")
    driver = TestClient.start(:driver, d)
    Geo.driver_update(%{id: d.id, name: d.name, photo: nil}, "home", nil)
    assert {:ok, _} = request(driver, "world", "sync", %{"geo" => ["hcell"]})

    for id <- @garbage_ids do
      assert {:error, %{reason: "unavailable"}} =
               request(driver, "world", "reveal", %{"id" => id}),
             "reveal #{inspect(id)}"
    end

    for payload <- [%{}, %{"ID" => hand.id}, %{"id" => [hand.id]}, "not a map", [1, 2]] do
      assert {:error, %{reason: "unavailable"}} = request(driver, "world", "reveal", payload),
             "reveal payload #{inspect(payload)}"
    end

    # still alive and still answering correctly
    assert {:ok, %{name: "hi-hand"}} = request(driver, "world", "reveal", %{"id" => hand.id})
  end

  test "sync: cell strings dressed up as topic names can't reach the other layer" do
    v = TestClient.start(:viewer, user("hi-v"))

    lies = ["h:hc", "geo:h:hc", "d:h:hc", ":h:hc", "agg:h:hc", "h", "geo:h:"]
    assert {:ok, _} = request(v, "world", "sync", %{"geo" => lies, "agg" => lies})

    held = :sys.get_state(TestClient.channel_pid(v)).assigns.held
    assert held != MapSet.new()

    for topic <- held,
        do: assert(String.starts_with?(topic, ["geo:d:", "agg:d:"]), "a viewer holds #{topic}")

    # hands raised in the cells those strings were dressed up as: nothing arrives
    Geo.hand_up(700_001, "hc", "s", ["hc"])
    Geo.hand_up(700_002, "h:hc", "s", ["h:hc"])

    for {event, payload} <- frames(v) do
      refute event in ~w(hand_update hand_left), "a viewer got #{event}"
      refute Map.has_key?(payload, :hands), "a viewer got #{inspect(payload)}"
    end
  end

  test "send_msg and request_ride: garbage targets never crash and never say who exists" do
    me = user("hi-me")
    client = TestClient.start(:me, me)
    topic = "user:#{me.id}"

    for to <- @garbage_ids do
      for event <- ["send_msg", "request_ride"] do
        assert {:error, %{reason: reason}} =
                 request(client, topic, event, %{"to" => to, "text" => "hi"})

        # an integer that names nobody reachable → the generic refusal; any
        # other shape is malformed. Neither says whether a user exists.
        assert reason in ["unavailable", "bad_request"], "#{event} to #{inspect(to)}: #{reason}"
      end
    end

    # a REAL user who isn't reachable looks exactly like a garbage integer
    real = user("hi-real")

    assert request(client, topic, "send_msg", %{"to" => real.id, "text" => "hi"}) ==
             request(client, topic, "send_msg", %{"to" => 2 ** 50, "text" => "hi"})

    # still alive
    assert {:error, %{reason: "self"}} =
             request(client, topic, "send_msg", %{"to" => me.id, "text" => "x"})
  end
end
