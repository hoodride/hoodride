defmodule HoodrideWeb.BrowserJourneysTest do
  @moduledoc """
  Browser journeys (owner, 2026-10-30): a real browser drives the real app
  — the glue in app.js that the Node tests can't load and the other Elixir
  tests only read. Each journey is a script in test_browser/ (Node, the
  browser's own debugging connection, no download); this starts the app on
  its own port with the test database and runs them, one test each.

  The browser: Microsoft Edge (ships with Windows), else Chrome or Brave;
  BROWSER= picks one. Headless, a throwaway profile per person.
  """
  use HoodrideWeb.ConnCase, async: false

  @moduletag :browser
  @moduletag timeout: 180_000
  @port 4100
  # where HoodrideWeb.Build keeps the server's build once computed
  @build_key {HoodrideWeb.Build, :build}

  # the journeys run what production runs: our own JS minified (as at
  # deploy — Mix.Tasks.Hoodride.Minify), served by HoodrideWeb.MinifiedStatic
  setup_all do
    dir =
      Path.join(System.tmp_dir!(), "hoodride_journeys_min_#{System.unique_integer([:positive])}")

    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    # (and our CSS too — the whole deploy build, Minify.build/4)
    0 = Mix.Tasks.Hoodride.Minify.build("priv/static", dir)
    %{minified: dir}
  end

  setup %{minified: minified} do
    Hoodride.TestHelpers.scrub_live_state()

    # every person and every reload comes from one address: no per-address
    # budgets here (as in dev)
    for key <- [:http_budget, :ws_budget, :sign_in_budget, :avatar_budget] do
      old = Application.get_env(:hoodride, key)
      Application.put_env(:hoodride, key, nil)
      on_exit(fn -> Application.put_env(:hoodride, key, old) end)
    end

    # a journey may "deploy" a new version (server("new_build")): the
    # server's own build is put back afterwards
    build = HoodrideWeb.Build.current()
    on_exit(fn -> :persistent_term.put(@build_key, build) end)
    # (and the Terms version, after server("terms_new"))
    on_exit(fn -> Application.delete_env(:hoodride, :terms_version) end)

    # the server's side of a failure: every socket connect and channel join,
    # when and how long it took (a join stuck "joining" under load, 2026-11-02).
    # Started BEFORE the server: ExUnit stops them in reverse, so the log
    # outlives the server — a browser's last request as the journey ends
    # (its tabs closing) found the log gone, and the recorder crashed
    # (2026-11-07)
    log = start_supervised!({Agent, fn -> [] end})

    start_supervised!(
      {Bandit, plug: {HoodrideWeb.MinifiedStatic, minified}, ip: {127, 0, 0, 1}, port: @port}
    )

    started = System.monotonic_time(:millisecond)
    handler = "journeys-#{System.unique_integer([:positive])}"

    :telemetry.attach_many(
      handler,
      [[:phoenix, :socket_connected], [:phoenix, :channel_joined], [:phoenix, :endpoint, :stop]],
      &__MODULE__.record/4,
      %{log: log, started: started}
    )

    on_exit(fn -> :telemetry.detach(handler) end)
    %{server_log: log}
  end

  @doc false
  def record(event, %{duration: d}, meta, %{log: log, started: started}) do
    at = System.monotonic_time(:millisecond) - started
    ms = System.convert_time_unit(d, :native, :millisecond)

    what =
      case event do
        [:phoenix, :socket_connected] ->
          "connect #{inspect(meta[:result])}"

        [:phoenix, :channel_joined] ->
          "join #{meta.socket.topic} #{elem_or(meta.result)}"

        # the page itself, and anything slow (a page stuck "loading", 0 files)
        [:phoenix, :endpoint, :stop] ->
          path = meta.conn.request_path
          if path in ["/", "/privacy"] or ms >= 300, do: "GET #{path} #{meta.conn.status}"
      end

    if what, do: Agent.update(log, &[" #{at} ms: #{what} (took #{ms} ms)" | &1])
  end

  defp elem_or({result, _}), do: inspect(result)
  defp elem_or(result), do: inspect(result)

  defp server_log(log) do
    case Agent.get(log, &Enum.reverse/1) do
      [] -> "server: no connects or joins at all"
      lines -> Enum.join(["server, connects and joins:" | Enum.take(lines, -40)], "\n")
    end
  end

  # every journey in test_browser/, found each time the tests start
  # (HoodrideWeb.Journeys) — one at a time: mix test test/browser --only journey:chats
  for journey <- HoodrideWeb.Journeys.list() do
    @tag journey: journey
    test "journey: #{journey}", %{server_log: log} do
      {out, code} = run_journey(unquote(journey))
      # BROWSER_VERBOSE=1: the steps of a passing journey too
      if System.get_env("BROWSER_VERBOSE"), do: IO.puts(out)
      assert code == 0, out <> "\n" <> server_log(log)
    end
  end

  # the script's output, line by line; a line "@@server <what>" asks this
  # test to do something on the server, answered on the script's stdin
  defp run_journey(name) do
    port =
      Port.open({:spawn_executable, System.find_executable("node")}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:line, 65_536},
        args: ["test_browser/#{name}.mjs"],
        env: [{~c"BASE", ~c"http://localhost:#{@port}"}]
      ])

    collect(port, [])
  end

  defp collect(port, lines) do
    receive do
      {^port, {:data, {:eol, "@@server " <> what}}} ->
        Port.command(port, server(what) <> "\n")
        collect(port, lines)

      {^port, {:data, {_, line}}} ->
        collect(port, [line | lines])

      {^port, {:exit_status, code}} ->
        {lines |> Enum.reverse() |> Enum.join("\n"), code}
    after
      170_000 ->
        Port.close(port)
        {lines |> Enum.reverse() |> Enum.join("\n"), :timeout}
    end
  end

  # as if a new version were deployed: the server now runs another build
  # (an open app learns it on its next (re)join — "Update available")
  defp server("new_build") do
    :persistent_term.put(@build_key, "journey-new-build")
    "ok"
  end

  # as if new Terms of Use were published: open apps are asked again
  defp server("terms_new") do
    Application.put_env(:hoodride, :terms_version, "2099-01-01")
    "ok"
  end

  defp server(other), do: "unknown request: #{other}"
end
