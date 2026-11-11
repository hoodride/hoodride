defmodule HoodrideWeb.PresenceProofTest do
  @moduledoc """
  Presence is derived from live channels, never from last-event claims.
  Born as a failing proof: last-writer presence marked a still-connected
  user as departing when a spare tab closed (or a dirty reload's late
  terminate landed after the new tab's join).
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, user} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "pp-u", name: "PP"})

    %{user: user}
  end

  defp open_tab(user) do
    {:ok, sock} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, chan} = subscribe_and_join(sock, "user:#{user.id}", %{})
    chan
  end

  defp close_tab(chan) do
    Process.unlink(chan.channel_pid)
    ref = Process.monitor(chan.channel_pid)
    close(chan)
    assert_receive {:DOWN, ^ref, :process, _, _}
  end

  defp kill_tab(chan) do
    Process.unlink(chan.channel_pid)
    ref = Process.monitor(chan.channel_pid)
    Process.exit(chan.channel_pid, :kill)
    assert_receive {:DOWN, ^ref, :process, _, _}
  end

  # Registry cleanup after a process death is asynchronous — poll briefly
  defp await_gone(user_id, tries \\ 300)
  defp await_gone(_user_id, 0), do: flunk("registry entry never cleaned up")

  defp await_gone(user_id, tries) do
    if Registry.lookup(Hoodride.UserChannels, user_id) == [] do
      :ok
    else
      Process.sleep(10)
      await_gone(user_id, tries - 1)
    end
  end

  test "closing one of two tabs leaves the user ONLINE", %{user: user} do
    _tab_a = open_tab(user)
    tab_b = open_tab(user)

    assert {:online, _} = Hoodride.Geo.presence_of(user.id)

    close_tab(tab_b)

    # the other tab still lives: presence must not start any departure clock
    assert {:online, _} = Hoodride.Geo.presence_of(user.id)

    # and the sweeper agrees — nothing of theirs is reapable
    Hoodride.Geo.driver_update(%{id: user.id, name: "PP", photo: nil}, "cell8pp", nil)
    Hoodride.Sweeper.sweep_now()
    assert Hoodride.Geo.driver_on_map?(user.id)
  end

  test "closing the LAST tab starts the grace clock", %{user: user} do
    tab_a = open_tab(user)
    tab_b = open_tab(user)

    close_tab(tab_a)
    close_tab(tab_b)
    await_gone(user.id)

    assert {:grace, since} = Hoodride.Geo.presence_of(user.id)
    assert is_integer(since)
  end

  test "a brutally killed channel still deregisters (no immortal online)", %{user: user} do
    tab = open_tab(user)
    assert {:online, _} = Hoodride.Geo.presence_of(user.id)

    kill_tab(tab)
    await_gone(user.id)

    # :kill skips terminate, so no grace stamp was written — but the Registry
    # can't be fooled: the user is NOT online. (Their stored row from join
    # supplies the clock; with none they'd read hard-offline. Either way the
    # reaper gets them — never an immortal ghost.)
    refute match?({:online, _}, Hoodride.Geo.presence_of(user.id))
  end

  # the REAL phone book (Hoodride.UserChannels) and a REAL user channel: the
  # phone book's process dying takes every channel down with it (no goodbye:
  # their presence rows still say ONLINE), it comes back EMPTY, and a sweep
  # in that gap keeps the user's car (the fix in Sweeper.past_grace?).
  # This module is not async: no other test's channels are cut.
  test "the real phone book dying: channels die with it, it restarts empty, the sweep keeps everyone",
       %{user: user} do
    tab = open_tab(user)
    Hoodride.Geo.driver_update(%{id: user.id, name: "PP", photo: nil}, "cell8rb", nil)
    assert [_] = Registry.lookup(Hoodride.UserChannels, user.id)

    Process.unlink(tab.channel_pid)
    ref = Process.monitor(tab.channel_pid)
    [{_, part, _, _}] = Supervisor.which_children(Hoodride.UserChannels)
    Process.exit(part, :kill)

    # the channel dies with the phone book — killed, no goodbye
    assert_receive {:DOWN, ^ref, :process, _, :killed}, 1000
    new_part = await_new_partition(part)
    assert new_part != part

    # the new phone book is empty, yet the presence row still says ONLINE
    assert Registry.lookup(Hoodride.UserChannels, user.id) == []
    refute Hoodride.Geo.connected?(user.id)
    assert [{_, :online, _}] = :ets.lookup(:geo_presence, user.id)

    # make the row look like they connected 10 min ago (over the 5-min grace)
    :ets.insert(:geo_presence, {user.id, :online, System.system_time(:second) - 600})
    Hoodride.Sweeper.sweep_now()

    assert Hoodride.Geo.driver_on_map?(user.id), "a sweep in the gap reaped a connected user"
    assert [{_, :grace, t}] = :ets.lookup(:geo_presence, user.id)
    assert t >= System.system_time(:second) - 2

    # the phone book works again: the app rejoining is listed
    _tab2 = open_tab(user)
    assert [_] = Registry.lookup(Hoodride.UserChannels, user.id)
  end

  defp await_new_partition(old, tries \\ 300)
  defp await_new_partition(_old, 0), do: flunk("the phone book never came back")

  defp await_new_partition(old, tries) do
    case Supervisor.which_children(Hoodride.UserChannels) do
      [{_, pid, _, _}] when is_pid(pid) and pid != old ->
        pid

      _ ->
        Process.sleep(10)
        await_new_partition(old, tries - 1)
    end
  end
end
