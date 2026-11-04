defmodule HoodrideWeb.RestartNoticeTest do
  @moduledoc """
  A planned restart (deploy.sh → systemctl restart → SIGTERM): before
  anything shuts down, Erlang calls the application's `prep_stop/1`; the
  server tells every connected app "restarting" with a retry window, waits a
  moment for those pushes to leave, then stops as usual. Each app then
  reconnects once at a random moment inside the window (sync.js
  restartWait) — not the growing backoff, which left phones in 8 s waits
  after the server was back (deploy test: everyone back in 22 s). A truly
  abrupt stop (crash, kill -9, power loss) sends nothing: the normal backoff
  applies, as before.
  """
  use HoodrideWeb.ConnCase, async: false

  import Phoenix.ChannelTest, only: [subscribe_and_join: 3, assert_push: 2]
  require Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  defp joined(key) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})

    {:ok, socket} =
      Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(u.id)}
      )

    {:ok, _, _} = subscribe_and_join(socket, "user:#{u.id}", %{})
    u
  end

  test "prep_stop tells every connected app: restarting, with the retry window" do
    joined("rn-a")
    joined("rn-b")
    assert Hoodride.Application.prep_stop(:the_state) == :the_state
    assert_push "restarting", %{min_ms: 4000, max_ms: 10000}
    assert_push "restarting", %{min_ms: 4000, max_ms: 10000}
  end

  test "the window and the pause are settings (config.exs; no pause in tests)" do
    base = Config.Reader.read!("config/config.exs", env: :prod)[:hoodride][:restart_notice]
    assert base[:min_ms] == 4000
    assert base[:max_ms] == 10000
    assert base[:flush_ms] >= 500, "time for the pushes to leave before the sockets close"
    assert Application.get_env(:hoodride, :restart_notice)[:flush_ms] == 0
  end
end
