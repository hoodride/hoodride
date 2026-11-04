defmodule HoodrideWeb.SharedSpotTest do
  @moduledoc """
  "How far away" in chat and requests (ARCHITECTURE.md "Distances"). The
  rule (owner's): someone who isn't driving shares their rough area — their
  ~170 m BLOCK, never a position — with a person by messaging them or
  requesting a ride from them. Online drivers are public as cars already;
  their messages carry nothing.

  The block goes to that ONE person, updated only when something is sent
  (never streamed), and never outlives its conversation or request. A
  fixed grid ("snap to grid") reveals nothing more however often it's
  asked — the fix dating apps adopted after trilateration leaks.
  """
  use ExUnit.Case, async: false

  alias Hoodride.{Chat, Geo, Requests, TestClient}
  import TestClient, only: [request: 4]

  @cell "882a1072c7fffff"
  @spot "892a1072c63ffff"
  @spot2 "892a1072c67ffff"

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

  defp profile(u), do: %{id: u.id, name: u.name, photo: u.photo}

  # an online driver, on screen for `rider`
  defp driver_seen_by(key, rider) do
    d = TestClient.start(String.to_atom(key), user(key))
    Geo.driver_update(profile(d.user), @cell, nil)
    {:ok, _} = request(rider, "world", "sync", %{"geo" => [@cell]})
    d
  end

  defp send_msg(client, to, extra),
    do:
      request(
        client,
        "user:#{client.user.id}",
        "send_msg",
        Map.merge(%{"to" => to, "text" => "hi"}, extra)
      )

  defp got(%TestClient{name: name}, event) do
    receive do
      {^name, :got, %Phoenix.Socket.Message{event: ^event, payload: p}} -> p
    after
      1_000 -> flunk("#{name} got no #{event}")
    end
  end

  describe "a message" do
    test "a rider's message carries their block to that driver", %{} do
      rider = TestClient.start(:rider, user("ss-r1"))
      driver = driver_seen_by("ss-d1", rider)

      assert {:ok, _} = send_msg(rider, driver.user.id, %{"spot" => @spot})
      assert %{spot: @spot, from: %{id: from}} = got(driver, "msg")
      assert from == rider.user.id
    end

    test "an online driver's message never carries a block", %{} do
      rider = TestClient.start(:rider, user("ss-r2"))
      driver = driver_seen_by("ss-d2", rider)
      {:ok, _} = send_msg(rider, driver.user.id, %{})
      _ = got(driver, "msg")

      assert {:ok, _} = send_msg(driver, rider.user.id, %{"spot" => @spot})
      assert %{spot: nil} = got(rider, "msg")
      assert Chat.conversations_for(rider.user.id) |> hd() |> Map.fetch!(:peer_spot) == nil
    end

    test "a malformed block is dropped; the message still goes", %{} do
      rider = TestClient.start(:rider, user("ss-r3"))
      driver = driver_seen_by("ss-d3", rider)

      for bad <- [String.duplicate("8", 40), 123, %{}, ""] do
        assert {:ok, _} = send_msg(rider, driver.user.id, %{"spot" => bad})
        assert %{spot: nil, text: "hi"} = got(driver, "msg")
      end
    end

    test "no block sent: none shown (and an earlier one stays the latest)", %{} do
      rider = TestClient.start(:rider, user("ss-r4"))
      driver = driver_seen_by("ss-d4", rider)
      {:ok, _} = send_msg(rider, driver.user.id, %{"spot" => @spot})
      {:ok, _} = send_msg(rider, driver.user.id, %{})

      assert %{spot: @spot} =
               Chat.conversations_for(driver.user.id) |> hd() |> Map.fetch!(:peer_spot)
    end

    test "the LATEST block wins, with its age — for the driver only", %{} do
      rider = TestClient.start(:rider, user("ss-r5"))
      driver = driver_seen_by("ss-d5", rider)
      {:ok, _} = send_msg(rider, driver.user.id, %{"spot" => @spot})
      {:ok, _} = send_msg(rider, driver.user.id, %{"spot" => @spot2})

      [convo] = Chat.conversations_for(driver.user.id)
      assert %{spot: @spot2, age_ms: age} = convo.peer_spot
      assert is_integer(age) and age >= 0
      # the rider sees no block of their own coming back
      assert Chat.conversations_for(rider.user.id) |> hd() |> Map.fetch!(:peer_spot) == nil
    end

    test "deleting the conversation deletes the block; the sweeper removes strays", %{} do
      rider = TestClient.start(:rider, user("ss-r6"))
      driver = driver_seen_by("ss-d6", rider)
      {:ok, _} = send_msg(rider, driver.user.id, %{"spot" => @spot})

      :ok = Chat.delete_conversation(Chat.pair_key(rider.user.id, driver.user.id))
      assert :ets.tab2list(:chat_spots) == []

      # a stray (a send racing a delete): gone at the next repair pass
      :ets.insert(:chat_spots, {{{1, 2}, 1}, @spot, 0})
      Chat.heal_index()
      assert :ets.tab2list(:chat_spots) == []
    end
  end

  describe "a ride request" do
    defp ask(client, to, extra),
      do:
        request(client, "user:#{client.user.id}", "request_ride", Map.merge(%{"to" => to}, extra))

    test "carries the rider's block to that driver, and into the driver's waiting list", %{} do
      rider = TestClient.start(:rider, user("ss-r7"))
      driver = driver_seen_by("ss-d7", rider)

      assert {:ok, _} = ask(rider, driver.user.id, %{"spot" => @spot})
      assert %{spot: @spot} = got(driver, "request")
      assert [%{spot: %{spot: @spot, age_ms: age}}] = Requests.pending_for_driver(driver.user.id)
      assert age >= 0
    end

    test "an ended request's block is never served — not even to a newer request", %{} do
      rider = TestClient.start(:rider, user("ss-r8"))
      driver = driver_seen_by("ss-d8", rider)
      {:ok, _} = ask(rider, driver.user.id, %{"spot" => @spot})
      _ = got(driver, "request")
      Requests.cancel(rider.user.id)

      # the stray row is ignored — even by a NEWER request between the same
      # two, made without a block (created directly: the app's 60 s
      # re-request cooldown would refuse it here)…
      assert Requests.pending_for_driver(driver.user.id) == []
      Process.sleep(1_100)
      :ok = Requests.create(profile(rider.user), driver.user.id)
      assert [%{spot: nil}] = Requests.pending_for_driver(driver.user.id)

      # …and swept once its own request is gone
      Requests.cancel(rider.user.id)
      Requests.heal_index(3600)
      assert :ets.tab2list(:request_spots) == []
    end

    test "no block, or a malformed one: the request still goes, without a distance", %{} do
      rider = TestClient.start(:rider, user("ss-r9"))
      driver = driver_seen_by("ss-d9", rider)
      assert {:ok, _} = ask(rider, driver.user.id, %{"spot" => String.duplicate("8", 40)})
      assert %{spot: nil} = got(driver, "request")
      assert [%{spot: nil}] = Requests.pending_for_driver(driver.user.id)
    end
  end
end
