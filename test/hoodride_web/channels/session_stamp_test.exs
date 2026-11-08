defmodule HoodrideWeb.SessionStampTest do
  @moduledoc """
  The device you chose last wins (Hoodride.SessionStamp).

  Choosing a device — opening the app, refreshing, "Use here" — gets a new
  stamp, higher than every stamp before it (a FENCING TOKEN: Kleppmann's
  "a number that increases", Kafka's producer epoch). A connect that is a
  choice takes over. An AUTOMATIC reconnect, or our silent update reload,
  keeps its tab's old stamp and gets in only if no higher stamp is known —
  not in the server's memory since it started, not held by a live socket.
  Otherwise it is told `session_moved` at every join, and closed.

  Before: newest connection won. A phone that lost its "you moved" (a
  tunnel, or the 1-in-18k drop the monster hunt found below the server)
  reconnected by itself and kicked the laptop the user was using.

  Each tab below is its own process — its own transport, as in production.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  alias Hoodride.SessionStamp

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "ss-a", name: "SsA"})

    %{u: u}
  end

  # ---------- a tab: one process = one transport ----------

  # connects with `params`, joins `topics`, reports each join's result, then
  # relays everything it receives to the test as {name, :got, msg}
  defp tab(name, user, params, topics \\ nil) do
    test = self()
    topics = topics || ["world", "user:#{user.id}"]

    pid =
      spawn_link(fn ->
        Process.flag(:trap_exit, true)

        {:ok, socket} =
          connect(HoodrideWeb.UserSocket, params,
            connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)},
            test_process: test
          )

        results =
          for t <- topics do
            case join(socket, t, %{}) do
              {:ok, reply, _chan} -> {t, {:ok, reply}}
              {:error, reply} -> {t, {:error, reply}}
            end
          end

        send(test, {name, :joined, results})
        relay(test, name)
      end)

    receive do
      {^name, :joined, results} -> %{name: name, pid: pid, joins: results, user: user}
    after
      2_000 -> flunk("tab #{name} didn't finish joining")
    end
  end

  defp relay(test, name) do
    receive do
      :stop ->
        :ok

      msg ->
        send(test, {name, :got, msg})
        relay(test, name)
    end
  end

  # a page that connects now and joins only when told (join_now/2): on a
  # quick refresh, the page just left keeps running for a moment
  defp connected(name, user, params) do
    test = self()

    pid =
      spawn_link(fn ->
        Process.flag(:trap_exit, true)

        {:ok, socket} =
          connect(HoodrideWeb.UserSocket, params,
            connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)},
            test_process: test
          )

        send(test, {name, :connected})

        receive do
          {:join, topic} ->
            result =
              case join(socket, topic, %{}) do
                {:ok, reply, _chan} -> {:ok, reply}
                {:error, reply} -> {:error, reply}
              end

            send(test, {name, :joined, result})
        end

        relay(test, name)
      end)

    assert_receive {^name, :connected}, 2_000
    %{name: name, pid: pid, user: user}
  end

  defp join_now(tab, topic) do
    name = tab.name
    send(tab.pid, {:join, topic})
    assert_receive {^name, :joined, result}, 2_000
    result
  end

  # a page load / "Use here": no stamp yet, a choice
  defp choose(name, user), do: tab(name, user, %{"takeover" => "true"})
  # an automatic reconnect (or a quiet reload) carrying the tab's stamp
  defp auto(name, user, stamp),
    do: tab(name, user, %{"stamp" => to_string(stamp), "takeover" => "false"})

  defp stamp_of(tab) do
    {_, {:ok, %{stamp: s}}} = List.keyfind(tab.joins, "user:#{tab.user.id}", 0)
    s
  end

  defp admitted?(tab), do: Enum.all?(tab.joins, fn {_, r} -> match?({:ok, _}, r) end)

  defp moved?(tab),
    do: Enum.all?(tab.joins, fn {_, r} -> r == {:error, %{reason: "session_moved"}} end)

  # told "you moved" on its live user channel
  defp told_moved?(tab, wait \\ 200) do
    name = tab.name

    receive do
      {^name, :got, %Phoenix.Socket.Message{event: "session_moved"}} -> true
    after
      wait -> false
    end
  end

  # its socket was closed by the server
  defp closed?(tab, wait \\ 200) do
    name = tab.name

    receive do
      {^name, :got, %Phoenix.Socket.Broadcast{event: "disconnect"}} -> true
    after
      wait -> false
    end
  end

  defp gone(tab) do
    ref = Process.monitor(tab.pid)
    send(tab.pid, :stop)
    assert_receive {:DOWN, ^ref, :process, _, _}
  end

  # the server restarts: every socket gone, its in-memory state wiped (the
  # stamp issuer keeps counting up — in production the clock carries it)
  defp restart(tabs) do
    Enum.each(tabs, &gone/1)
    :ets.delete_all_objects(:session_highest)
  end

  # ---------- the stamp issuer ----------

  describe "stamps" do
    test "always go up — even when the clock jumps backwards" do
      a = SessionStamp.issue(5_000_000)
      b = SessionStamp.issue(1_000)
      c = SessionStamp.issue(1_000)
      assert a >= 5_000_000
      assert b > a and c > b
      assert SessionStamp.issue(a + 1_000_000) == a + 1_000_000
    end

    test "issued at the same moment, never twice the same" do
      # 64 processes hammering the issuer at once, the clock standing still
      stamps =
        1..64
        |> Enum.map(fn _ ->
          Task.async(fn -> for _ <- 1..2_000, do: SessionStamp.issue(42) end)
        end)
        |> Enum.flat_map(&Task.await/1)

      assert length(Enum.uniq(stamps)) == 128_000
    end

    test "the highest stamp seen per account only ever rises", %{u: u} do
      1..500
      |> Task.async_stream(fn s -> SessionStamp.saw(u.id, s) end, max_concurrency: 64)
      |> Stream.run()

      SessionStamp.saw(u.id, 7)
      assert SessionStamp.highest(u.id) == 500
    end
  end

  describe "decide/4 — who gets in" do
    test "a choice always takes over" do
      assert SessionStamp.decide(true, nil, 900, [800]) == :take_over
    end

    test "an automatic connect needs the highest stamp known" do
      assert SessionStamp.decide(false, 10, nil, []) == :take_over
      assert SessionStamp.decide(false, 10, 10, [10]) == :take_over
      assert SessionStamp.decide(false, 10, 9, [5]) == :take_over
      # a higher stamp in the server's memory (no live socket needed)
      assert SessionStamp.decide(false, 10, 11, []) == :moved
      # a higher stamp held by a live socket (memory wiped by a restart)
      assert SessionStamp.decide(false, 10, nil, [11]) == :moved
    end

    test "an automatic connect without a stamp is no choice: moved" do
      assert SessionStamp.decide(false, nil, nil, []) == :moved
    end
  end

  # ---------- real sockets ----------

  test "refresh past a dead leftover: the new page gets in, and is never told it moved", %{u: u} do
    leftover = choose(:old_page, u)
    page = choose(:new_page, u)

    assert admitted?(page)
    refute told_moved?(page)
    refute closed?(page)
    # the leftover (dead in real life) was handed over
    assert told_moved?(leftover)
    assert stamp_of(page) > stamp_of(leftover)
  end

  # a quick refresh (2026-11-01, caught by the browser journeys): the page
  # just left was still running, and its user join landed as the new
  # page's did. Each join kicked every other one — so the page in use was
  # told "opened on another device" too, and stopped reconnecting.
  test "a refresh mid-join: the page left behind joins late — the new page stays", %{u: u} do
    leaving = connected(:leaving, u, %{"takeover" => "true"})
    page = choose(:page, u)

    assert {:ok, _} = join_now(leaving, "user:#{u.id}")
    refute told_moved?(page), "the page in use was told it moved"
    refute closed?(page)
    # the page left behind steps aside
    assert told_moved?(leaving)
  end

  test "and the other way round: the old page joins first — the new page still wins", %{u: u} do
    leaving = connected(:leaving, u, %{"takeover" => "true"})
    assert {:ok, _} = join_now(leaving, "user:#{u.id}")
    page = choose(:page, u)

    assert admitted?(page)
    refute told_moved?(page)
    assert told_moved?(leaving)
  end

  test "the same tab reconnecting by itself replaces its own leftover, silently", %{u: u} do
    first = choose(:tab, u)
    again = auto(:tab_again, u, stamp_of(first))

    assert admitted?(again)
    refute told_moved?(again)
    refute closed?(again)
    assert stamp_of(again) == stamp_of(first), "a reconnect keeps its tab's stamp"
  end

  test "the tunnel phone: an older stamp reconnecting by itself is moved; the laptop is untouched",
       %{u: u} do
    phone = choose(:phone, u)
    laptop = choose(:laptop, u)
    # (the phone never heard it moved: it reconnects by itself)
    zombie = auto(:zombie, u, stamp_of(phone))

    assert moved?(zombie)
    assert closed?(zombie)
    refute told_moved?(laptop)
    refute closed?(laptop)
  end

  test "a blip: nothing is live, but a higher stamp is known — still moved", %{u: u} do
    phone = choose(:phone, u)
    laptop = choose(:laptop, u)
    gone(phone)
    gone(laptop)

    zombie = auto(:zombie, u, stamp_of(phone))
    assert moved?(zombie)

    back = auto(:laptop_back, u, stamp_of(laptop))
    assert admitted?(back)
  end

  test "\"Use here\": a choice takes over, the other is told it moved", %{u: u} do
    laptop = choose(:laptop, u)
    phone = choose(:phone_use_here, u)

    assert admitted?(phone)
    assert told_moved?(laptop)
    assert closed?(laptop)
  end

  test "a quiet update reload while another device is live does not take over", %{u: u} do
    pocket = choose(:pocket, u)
    laptop = choose(:laptop, u)
    reloaded = auto(:pocket_reload, u, stamp_of(pocket))

    assert moved?(reloaded)
    refute told_moved?(laptop)
  end

  test "after a restart: a zombie that arrives first gets in, until the chosen device does",
       %{u: u} do
    phone = choose(:phone, u)
    laptop = choose(:laptop, u)
    restart([phone, laptop])

    zombie = auto(:zombie, u, stamp_of(phone))
    assert admitted?(zombie), "the server can't know yet (no database: the known cost)"

    back = auto(:laptop_back, u, stamp_of(laptop))
    assert admitted?(back)
    assert told_moved?(zombie)
    refute told_moved?(back)
  end

  test "a moved socket gets no map, user or ride data, and is closed", %{u: u} do
    phone = choose(:phone, u)
    _laptop = choose(:laptop, u)

    zombie =
      tab(:zombie, u, %{"stamp" => to_string(stamp_of(phone)), "takeover" => "false"}, [
        "world",
        "user:#{u.id}",
        "ride:r123"
      ])

    assert moved?(zombie)
    assert closed?(zombie)

    refute Registry.lookup(Hoodride.WorldChannels, u.id)
           |> Enum.any?(fn {_, t} -> t == zombie.pid end)

    refute Registry.lookup(Hoodride.UserChannels, u.id)
           |> Enum.any?(fn {_, t} -> t == zombie.pid end)
  end

  test "refused joins of a moved socket don't spend the account's join budget", %{u: u} do
    phone = choose(:phone, u)
    laptop = choose(:laptop, u)

    # one moved socket asking 40 times (more than the join burst)
    zombie =
      tab(
        :zombie,
        u,
        %{"stamp" => to_string(stamp_of(phone)), "takeover" => "false"},
        List.duplicate("world", 40)
      )

    assert moved?(zombie)
    # the live laptop's next joins still go through
    assert admitted?(auto(:laptop_again, u, stamp_of(laptop)))
  end

  test "garbage and future stamps are refused, safely", %{u: u} do
    _laptop = choose(:laptop, u)
    future = SessionStamp.issue() + 3_600_000_000

    for {s, i} <-
          Enum.with_index([
            "abc",
            "-5",
            "1e3",
            "",
            "12 ",
            "99999999999999999999999",
            to_string(future)
          ]) do
      t = tab(:"g#{i}", u, %{"stamp" => s, "takeover" => "false"})
      assert moved?(t), "stamp #{inspect(s)}"
    end

    for {params, i} <-
          Enum.with_index([%{"stamp" => %{}}, %{"takeover" => ["x"]}, %{"stamp" => nil}]) do
      t = tab(:"h#{i}", u, params)
      assert admitted?(t) or moved?(t), "params #{inspect(params)}"
    end
  end

  test "an old app (no stamp, no flag) behaves as before: newest wins", %{u: u} do
    old = tab(:old_app, u, %{})
    new = tab(:old_app_again, u, %{})
    assert admitted?(new)
    assert told_moved?(old)
  end

  test "a choice always gets a NEW, higher stamp — even if it sent an old one", %{u: u} do
    first = choose(:first, u)
    again = tab(:again, u, %{"takeover" => "true", "stamp" => to_string(stamp_of(first))})
    assert stamp_of(again) > stamp_of(first)
  end

  test "the user join reply carries the tab's stamp", %{u: u} do
    t = choose(:t, u)
    assert is_integer(stamp_of(t)) and stamp_of(t) > 0
  end

  # ---------- the map join follows the stamps too (server review, 2026-11-08) ----------
  # It used to be "the latest map join wins": an older device's late map
  # join shut down the NEWER device's map — which then stopped updating
  # (cars frozen, no hands) until a reload, because the app never asks for
  # the map again by itself. Now: a strictly older device steps aside; a
  # strictly older one already there is replaced AND its connection closed
  # (a map left dead under a live connection never comes back); equal or
  # unknown stamps are left alone (the same tab's own leftover, already
  # being closed — replacing on equal stamps could leave two dead maps).

  defp map_alive?(tab) do
    name = tab.name

    receive do
      {^name, :got, %Phoenix.Socket.Message{event: "phx_close"}} -> false
    after
      200 ->
        Registry.lookup(Hoodride.WorldChannels, tab.user.id)
        |> Enum.any?(fn {_, transport} -> transport == tab.pid end)
    end
  end

  test "the older device's map join arriving LATE: refused — the newer device keeps its map",
       %{u: u} do
    laptop = connected(:laptop, u, %{"takeover" => "true"})
    phone = choose(:phone, u)

    # the laptop's map request arrives after the phone's map is up
    assert join_now(laptop, "world") == {:error, %{reason: "session_moved"}}
    assert closed?(laptop)
    assert map_alive?(phone), "the newer device's map was shut down"
    refute told_moved?(phone)
    refute closed?(phone)
  end

  test "the older device's map already there: replaced, and its connection closed", %{u: u} do
    laptop = tab(:laptop, u, %{"takeover" => "true"}, ["world"])
    phone = connected(:phone, u, %{"takeover" => "true"})
    # (the phone's connect already tells the laptop's socket to close — a
    # real connect racing the laptop's can miss it: what the MAP join does
    # is what's tested here)
    _ = closed?(laptop)

    assert {:ok, _} = join_now(phone, "world")
    assert map_alive?(phone)
    # no map left dead under a live connection: the whole connection goes
    assert closed?(laptop, 500), "the older connection was left with a dead map"
  end

  test "the same tab's leftover (equal stamps): both maps left alone, nobody closed", %{u: u} do
    first = choose(:tab, u)
    again = auto(:tab_again, u, stamp_of(first))

    assert admitted?(again)
    assert map_alive?(again)
    refute closed?(again)
  end

  test "an equal stamp's map is never closed by a map join", %{u: u} do
    first = tab(:first, u, %{"takeover" => "true"}, ["world"])
    {_, {:ok, %{stamp: s}}} = List.keyfind(first.joins, "world", 0)
    again = connected(:again, u, %{"stamp" => to_string(s), "takeover" => "false"})
    # (the reconnect's own connect already told the leftover to close — what
    # the MAP join does is what's tested here)
    _ = closed?(first)

    assert {:ok, _} = join_now(again, "world")
    refute closed?(first, 300), "a map join closed an equal stamp's connection"
    assert map_alive?(again)
  end

  test "a second map join on the SAME connection never closes that connection", %{u: u} do
    t = tab(:twice, u, %{"takeover" => "true"}, ["world", "user:#{u.id}", "world"])
    assert admitted?(t)
    refute closed?(t)
    refute told_moved?(t)
  end

  test "the map join reply carries the tab's stamp too (a lost user reply can't lose it)", %{
    u: u
  } do
    t = choose(:t, u)
    {_, {:ok, %{stamp: s}}} = List.keyfind(t.joins, "world", 0)
    assert s == stamp_of(t)
  end
end
