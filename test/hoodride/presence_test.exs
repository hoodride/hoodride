defmodule Hoodride.PresenceTest do
  @moduledoc """
  Is someone still AROUND? (Hoodride.Presence — owner, 2026-11-17): the one
  rule for what memory keeps per person, shared by their blocks
  (Hoodride.Blocks) and their sign-ins (Hoodride.SessionTokens). Around =
  connected; or left within the presence grace; or in a ride; or with a
  ride request open — asking, or asked. Every case, and the edges of the
  grace.
  """
  use Hoodride.DataCase, async: false

  alias Hoodride.{Accounts, Geo, Presence, Requests, Rides}

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  @grace div(Hoodride.Limits.presence_grace_ms(), 1000)

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp m(u), do: %{id: u.id, name: u.name, photo: nil}
  defp on_map(u), do: Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, "cell8", nil)

  test "never seen: not around" do
    refute Presence.around?(user("pr-none").id)
  end

  test "connected (a live user channel): around — however long ago they connected" do
    u = user("pr-conn")
    {:ok, _} = Registry.register(Hoodride.UserChannels, u.id, nil)
    assert Presence.around?(u.id)
    assert Presence.around?(u.id, System.system_time(:second) + 10 * @grace)
  end

  test "left: around through the grace — to its last second — then not" do
    u = user("pr-grace")
    Geo.user_disconnected(u.id)
    since = Geo.grace_since(u.id)
    assert Presence.around?(u.id, since)
    assert Presence.around?(u.id, since + @grace), "the last second of the grace"
    refute Presence.around?(u.id, since + @grace + 1)
  end

  test "in a ride: around, rider and driver alike, long after leaving" do
    [rider, driver] = [user("pr-ride-r"), user("pr-ride-d")]
    {:ok, _} = Rides.start_ride(rider.id, driver.id)
    later = System.system_time(:second) + 10 * @grace
    assert Presence.around?(rider.id, later)
    assert Presence.around?(driver.id, later)
  end

  test "asking for a ride (a request open): around — the rider and the driver asked" do
    [rider, driver] = [user("pr-req-r"), user("pr-req-d")]
    on_map(driver)
    :ok = Requests.create(m(rider), driver.id)
    later = System.system_time(:second) + 10 * @grace
    assert Presence.around?(rider.id, later), "asking"
    assert Presence.around?(driver.id, later), "asked"
  end

  test "the request over: not around any more (nothing else keeps them)" do
    [rider, driver] = [user("pr-done-r"), user("pr-done-d")]
    on_map(driver)
    :ok = Requests.create(m(rider), driver.id)
    Requests.cancel(rider.id)
    later = System.system_time(:second) + 10 * @grace
    refute Presence.around?(rider.id, later)
    refute Presence.around?(driver.id, later)
  end
end
