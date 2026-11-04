defmodule HoodrideWeb.RestartNotice do
  @moduledoc """
  A PLANNED restart (deploy.sh → systemctl restart → SIGTERM): before
  anything shuts down, `Hoodride.Application.prep_stop/1` calls `announce/0`
  — every connected app is told "restarting" with a retry window, then a
  short pause lets those pushes leave before the sockets close. Each app
  reconnects once at a random moment inside the window (sync.js
  restartWait) instead of the growing backoff, which left phones in 8 s
  waits after the server was back (deploy test at 4,000: everyone back in
  22 s). A truly abrupt stop (crash, kill -9, power loss) sends nothing:
  the normal backoff applies, as before.

  Every user channel subscribes to `topic/0` at join (HoodrideWeb.UserChannel).
  `config :hoodride, :restart_notice, min_ms:, max_ms:, flush_ms:`.
  """

  @topic "server:restart"

  def topic, do: @topic

  def announce do
    cfg = Application.get_env(:hoodride, :restart_notice, [])
    window = %{min_ms: Keyword.get(cfg, :min_ms, 4000), max_ms: Keyword.get(cfg, :max_ms, 10_000)}
    Phoenix.PubSub.broadcast(Hoodride.PubSub, @topic, {:restarting, window})
    Process.sleep(Keyword.get(cfg, :flush_ms, 1000))
    :ok
  end
end
