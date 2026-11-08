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

  # (server("older_device …"): another device's socket, made here)
  require Phoenix.ChannelTest

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

    # requests refused as coming from another site (HoodrideWeb.CrossOrigin):
    # counted here, asked for by server("cross_site_refused")
    refused = :counters.new(1, [])
    refused_handler = "journeys-refused-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      refused_handler,
      [:hoodride, :cross_origin, :refused],
      fn _, _, _, c -> :counters.add(c, 1, 1) end,
      refused
    )

    on_exit(fn -> :telemetry.detach(refused_handler) end)
    Process.put(:cross_site_refused, refused)
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

  # as if this person had already started the hour's 20 new chats: spent
  # until the real limit (Hoodride.Throttle) refuses — whatever the journey
  # used already — so the next cold contact is refused
  defp server("cold_used_up " <> id) do
    user = String.to_integer(id)

    spent =
      Enum.reduce_while(1..21, 0, fn _, n ->
        case Hoodride.Throttle.new_conversation(user) do
          :ok -> {:cont, n + 1}
          {:deny, _} -> {:halt, n}
        end
      end)

    if spent < 21, do: "ok", else: "the limit never refused"
  end

  # as if a minute had passed since a cancel or a decline: the pair's
  # re-request cooldown (Hoodride.Throttle) is over — every rate counter
  # starts afresh, as at the start of each test (scrub_live_state)
  defp server("cooldown_over") do
    :ets.delete_all_objects(Hoodride.RateLimit)
    "ok"
  end

  # 15 people have each written this person once (W1 first, W15 last): more
  # chats than fit on screen, real ones a reload brings back
  defp server("fifteen_write " <> id) do
    to = String.to_integer(id)

    for i <- 1..15 do
      name = "BT-W#{i}"

      {:ok, u} =
        Hoodride.Accounts.upsert_oauth_user(%{
          provider: "dev",
          provider_id: name,
          name: name,
          photo: nil
        })

      {:ok, _} = Hoodride.Chat.send_message(u, to, "w#{i}")
    end

    "ok"
  end

  # a ride between this rider and driver, started as an accept starts one
  # (both are told)
  defp server("start_ride " <> ids) do
    [rider, driver] = ids |> String.split() |> Enum.map(&String.to_integer/1)
    {:ok, _} = Hoodride.Rides.start_ride(rider, driver)
    "ok"
  end

  # the rider's ride ends and a new one starts between the same two — at
  # once, as if both landed within one reload
  defp server("swap_ride " <> ids) do
    [rider, driver] = ids |> String.split() |> Enum.map(&String.to_integer/1)
    old = Hoodride.Rides.ride_id_of_user(rider)
    [{pid, _}] = Registry.lookup(Hoodride.Rides.Registry, old)
    ref = Process.monitor(pid)
    Hoodride.Rides.end_ride(old, rider)

    receive do
      {:DOWN, ^ref, :process, ^pid, _} -> :ok
    after
      5_000 -> raise "the ride didn't end"
    end

    {:ok, _new} = Hoodride.Rides.start_ride(rider, driver)
    "ok"
  end

  # every conversation this person has is deleted (as when everyone they
  # talked to has gone) — both sides are told, as by the sweeper
  defp server("close_chats " <> id) do
    user = String.to_integer(id)

    for c <- Hoodride.Chat.conversations_for(user),
        do: Hoodride.Chat.delete_conversation(Hoodride.Chat.pair_key(user, c.peer_id))

    "ok"
  end

  # `n` messages from one person to another, sent at once ("m1"…"mN", or
  # another prefix), past the per-minute limits (those aren't what's tested)
  defp server("many_msgs " <> args) do
    [from, to, n | rest] = String.split(args)
    prefix = List.first(rest) || "m"
    sender = Hoodride.Accounts.get_user(String.to_integer(from))

    for i <- 1..String.to_integer(n),
        do: {:ok, _} = Hoodride.Chat.send_message(sender, String.to_integer(to), "#{prefix}#{i}")

    "ok"
  end

  # these two's conversation is deleted (as when one of them has gone) —
  # both are told, as by the sweeper
  defp server("close_chat " <> ids) do
    [a, b] = ids |> String.split() |> Enum.map(&String.to_integer/1)
    Hoodride.Chat.delete_conversation(Hoodride.Chat.pair_key(a, b))
    "ok"
  end

  # someone new and this person share a conversation with no message in it
  # yet (as a ride opens one)
  defp server("quiet_chat " <> id) do
    {:ok, quiet} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "dev",
        provider_id: "BT-Quiet",
        name: "BT-Quiet",
        photo: nil
      })

    :ok = Hoodride.Chat.open(String.to_integer(id), quiet.id)
    "ok"
  end

  # another device of this account: connected (a choice — it takes over
  # from the page open now), but joined to nothing yet. A page loaded AFTER
  # it is newer (Hoodride.SessionStamp). Lives until the journey ends.
  defp server("older_device " <> id) do
    user = String.to_integer(id)
    test = self()

    pid =
      spawn_link(fn ->
        {:ok, socket} =
          Phoenix.ChannelTest.connect(HoodrideWeb.UserSocket, %{"takeover" => "true"},
            connect_info: %{session: Hoodride.TestHelpers.session_for(user)},
            test_process: test
          )

        send(test, {:older_device, :connected})
        older_device(socket)
      end)

    receive do
      {:older_device, :connected} ->
        Process.put(:older_device, pid)
        "ok"
    after
      5_000 -> "the other device didn't connect"
    end
  end

  # …its join of `topic` arriving now (late): "ok" only if it is REFUSED as
  # the older device ("opened on another device")
  defp server("older_device_refused " <> topic) do
    send(Process.get(:older_device), {:join, topic, self()})

    receive do
      {:older_device, "refused session_moved"} -> "ok"
      {:older_device, other} -> "the older device's join was not refused: #{other}"
    after
      5_000 -> "no answer"
    end
  end

  # as if this account signed out on another device ("Sign out" is on all
  # devices: every sign-in deleted, every connection told — as the app's
  # own sign-out, HoodrideWeb.AuthController.logout)
  defp server("sign_out_everywhere " <> id) do
    user = String.to_integer(id)
    :ok = Hoodride.Accounts.mark_logged_out(user)
    HoodrideWeb.Endpoint.broadcast("user_socket:#{user}", "disconnect", %{})
    "ok"
  end

  # as if `days` had passed since every sign-in of this account was made
  # (and its real sign-in), in memory and the database
  defp server("age_sign_ins " <> args) do
    [id, days] = String.split(args)
    {user, ms} = {String.to_integer(id), String.to_integer(days) * 86_400_000}

    for {h, ^user, ins, auth} <- :ets.tab2list(:session_tokens) do
      :ets.insert(:session_tokens, {h, user, ins - ms, auth - ms})
    end

    Hoodride.Repo.query!(
      "UPDATE user_tokens SET inserted_at = inserted_at - ?, authenticated_at = authenticated_at - ? WHERE user_id = ?",
      [ms, ms, user]
    )

    "ok"
  end

  # "ok" once at least one request was refused as coming from another site
  defp server("cross_site_refused") do
    case :counters.get(Process.get(:cross_site_refused), 1) do
      0 -> "nothing was refused as coming from another site"
      _ -> "ok"
    end
  end

  defp server(other), do: "unknown request: #{other}"

  defp older_device(socket) do
    receive do
      {:join, topic, from} ->
        result =
          case Phoenix.ChannelTest.join(socket, topic, %{}) do
            {:ok, _reply, _chan} -> "joined"
            {:error, %{reason: reason}} -> "refused " <> reason
          end

        send(from, {:older_device, result})
        older_device(socket)
    end
  end
end
