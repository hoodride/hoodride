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
end
