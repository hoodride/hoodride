defmodule HoodrideWeb.WorldChannel do
  @moduledoc """
  The multiplexer ("Option B"): ONE channel process per client manages ALL
  of that client's map subscriptions. Watched cells are Phoenix.PubSub
  registry entries (~100 bytes each) held by this single process, instead
  of one channel process per cell — a browsing client costs ~3 processes
  instead of ~85, and process-table exhaustion via subscription hoarding
  is structurally unrepresentable.

  Protocol — LEVEL-TRIGGERED (read-only world; writes stay on UserChannel):

    push "sync", %{"geo" => [every cell wanted now], "agg" => [every cell wanted now]}

  Each sync carries the client's COMPLETE desired set, never a diff. The
  server reconciles it against what it actually holds: unsubscribe what is
  no longer wanted (first), subscribe what is new (never twice), snapshot
  only the new topics (after subscribing, so no live update can fall between
  snapshot and stream). Sending the same set again is a no-op.

  Why full sets: with diffs, the client had to track what the server held,
  and any refused, lost or timed-out sync left the two out of step for good
  (reproduced: a refused sync left a cell blank forever). With full sets
  there is nothing to drift — the next sync, whenever it lands, carries the
  whole truth. Same principle as Kubernetes' level-triggered reconciliation
  and the full-set re-subscribe in Socket.io / geOps vehicle maps; the state
  is ≤120 short ids (~2-3 KB), so sending all of it costs nothing.

  Refusals change NOTHING: over the cap → watch_limit; over the sync budget →
  rate_limited with `retry_ms`, the exact wait until the next sync fits.

  WHO RECEIVES WHAT (privacy): a cell is only a wish; WHICH topic of it this
  channel holds is decided by the user's server-derived role
  (Hoodride.Roles) — a viewer gets the car layer, an online driver the hand
  layer, someone in a ride nothing. Filtering in the app is not privacy:
  anything on the wire can be read. Three things keep it exact:

    1. a role change pings `role:<user>`; this channel then drops every
       topic the new role may not hold and pushes "role". It subscribes
       nothing itself: the app clears the layer it lost and resyncs, and the
       ordinary reconcile (under the ordinary sync budget) brings the new
       layer. A server-pushed snapshot would bypass that budget.
    2. every forwarded message is checked against the LIVE role (two ETS
       lookups), so a broadcast queued in this mailbox before a role ping
       is still dropped.
    3. every sync re-derives the role, so a lost ping heals on the next one
       (the app resyncs at least every ~60 s).

  ONE per account: a newer world join closes the older one (newest wins,
  as on the user channel) — otherwise a script could open many world-only
  sockets and multiply the per-connection sync and reveal budgets.
  """
  use HoodrideWeb, :channel

  alias Hoodride.{Geo, Roles}

  # WHY 120: the client watches the cells touching a rectangle ~one cell
  # wider than the screen, at the finest zoom-ladder level where that fits
  # its single budget of 110 (MAX_WATCHED_CELLS in app.js, enforced by an
  # exact count before every sync). So an honest client never asks for more
  # than 110; 120 leaves headroom while capping a hostile client's
  # worst-case hoard at 120 × ~100 bytes ≈ 12 KB of registry, versus the
  # unbounded hoard this limit exists to prevent. The cap is checked on the
  # DESIRED set before anything changes: all or nothing.
  @max_watch 120

  # same opaque-cell rule as every other surface
  @max_cell_bytes 24

  # THE SYNC BUDGET (flow limit, completing what the cap's stock limit can't):
  # every new cell costs a snapshot, so a spin loop (set A, set B, set A...)
  # would treadmill the server without ever tripping the cap. 60 syncs/min
  # with burst 20 — the client coalesces map moves into at most one sync in
  # flight, so a human never sees this; a loop walls out inside a second.
  # Per USER (Hoodride.RateBudget): leaving and rejoining, or another
  # connection, spends from the same allowance (it used to live in this
  # channel's assigns, and a rejoin refilled it). Refusals are cheap and
  # spend nothing, so we keep refusing rather than hanging up. `reveal`
  # spends from the same budget: a tap is rare, so one covers both.
  @sync_per_minute 60
  @sync_burst 20

  # a batched reveal: at most a burst of ids (priv/static/reveal_queue.js
  # sends no more — test/hoodride_web/channels/reveal_batch_test.exs)
  def reveal_max, do: @sync_burst
  # (the profile-photo budget is twice these: config.exs :avatar_budget)
  def reveal_per_minute, do: @sync_per_minute

  # THE WIRE PROTOCOL VERSION, in the join reply. The app compares it with
  # its own (PROTOCOL in app.js) and offers a reload when they differ: a tab
  # left open across a deploy would otherwise keep reconnecting with old
  # code against messages it can't read. Bump BOTH when a payload changes.
  # 2: cars travel as {id, cell, spot}; names only via reveal.
  # 3: map updates may arrive as one "batch" (see :map_batch_ms below).
  @protocol 3
  def protocol, do: @protocol

  # a socket that lost the session is refused first (HoodrideWeb.SessionGate);
  # then every join spends the user's join budget: a refused join does no
  # work at all (HoodrideWeb.JoinBudget)
  @impl true
  def join(topic, params, socket) do
    with :ok <- HoodrideWeb.SessionGate.check(socket),
         :ok <- HoodrideWeb.JoinBudget.check(socket),
         do: do_join(topic, params, socket)
  end

  defp do_join("world", _params, socket) do
    user_id = socket.assigns.user_id
    own = socket.transport_pid
    mine = socket.assigns[:stamp]

    # One map per account, the device chosen LAST (Hoodride.SessionStamp) —
    # not whichever map join lands last: that let an older device's late
    # join shut down the newer device's map, which then never updated again
    # (server review, 2026-11-08). Register FIRST, then look: two map joins
    # at the same moment each see the other and reach the same verdict.
    # The value is our transport, so the user channel on the SAME socket
    # can find us (HoodrideWeb.Reach).
    {:ok, _} = Registry.register(Hoodride.WorldChannels, user_id, own)
    stamps = Map.new(Registry.lookup(Hoodride.SocketStamps, user_id))

    if Enum.any?(stamps, fn {transport, s} -> transport != own and newer?(s, mine) end) do
      # a newer device is live: this one steps aside, as HoodrideWeb.SessionGate
      # (the transport writes this join's reply first, then reads this)
      send(own, %Phoenix.Socket.Broadcast{
        topic: "user_socket:#{user_id}",
        event: "disconnect",
        payload: %{}
      })

      {:error, %{reason: "session_moved"}}
    else
      # strictly OLDER devices' maps go — with their whole connection: a map
      # shut down under a live connection never comes back. Equal or unknown
      # stamps are left alone (the same tab's own leftover, already being
      # closed; replacing on equal stamps could leave two dead maps), and
      # never our own connection.
      for transport <- Registry.lookup(Hoodride.WorldChannels, user_id) |> transports(),
          transport != own,
          older?(Map.get(stamps, transport), mine),
          do: move_aside(user_id, transport)

      joined(socket, user_id, mine)
    end
  end

  # (a connection rejoining its map is briefly listed twice)
  defp transports(entries), do: entries |> Enum.map(&elem(&1, 1)) |> Enum.uniq()

  defp newer?(stamp, mine), do: is_integer(stamp) and is_integer(mine) and stamp > mine
  defp older?(stamp, mine), do: is_integer(stamp) and is_integer(mine) and stamp < mine

  # an older device's connection: told "opened on another device" by its
  # user channel (which then closes the socket), or closed directly
  defp move_aside(user_id, transport) do
    case for({chan, ^transport} <- Registry.lookup(Hoodride.UserChannels, user_id), do: chan) do
      [chan | _] ->
        send(chan, :session_moved)

      [] ->
        send(transport, %Phoenix.Socket.Broadcast{
          topic: "user_socket:#{user_id}",
          event: "disconnect",
          payload: %{}
        })
    end
  end

  defp joined(socket, user_id, stamp) do
    :ok = Phoenix.PubSub.subscribe(Hoodride.PubSub, Roles.topic(user_id))
    role = Roles.of(user_id)

    # the tab's stamp here too: the app keeps it even if the user join's
    # reply is lost (it carries it on every automatic reconnect)
    {:ok,
     %{role: role_name(role), v: @protocol, build: HoodrideWeb.Build.current(), stamp: stamp},
     assign(socket,
       geo: MapSet.new(),
       agg: MapSet.new(),
       held: MapSet.new(),
       role: role,
       batch_ms: Application.get_env(:hoodride, :map_batch_ms, 500),
       # off only to measure against: each update re-encoded per watcher
       encode_once: Application.get_env(:hoodride, :map_encode_once, true),
       pending: %{},
       seq: 0,
       flush_timer: nil
     )}
  end

  # everything held goes out BEFORE any reply: a sync's fresh snapshot must
  # never be followed by an older position (and a barrier means "all sent")
  @impl true
  def handle_in(event, payload, socket), do: route(event, payload, flush(socket))

  defp route("sync", payload, socket) do
    case Hoodride.RateBudget.spend(socket, :sync, @sync_per_minute, @sync_burst) do
      {:deny, socket} ->
        wait = Hoodride.RateBudget.wait_ms(socket, :sync, @sync_per_minute, @sync_burst)
        {:reply, {:error, %{reason: "rate_limited", retry_ms: max(wait, 1)}}, socket}

      {:ok, socket} ->
        reconcile(payload, socket)
    end
  end

  # REVEAL: who is behind a ✋ or a 🚗 (both travel anonymously — id, cell,
  # spot). Only for the role that receives that marker (an online driver for
  # hands, a viewer for cars), and only for one in a hex this channel is
  # receiving right now — the marker is already on their screen. Every other
  # case gets the SAME answer, so nothing can be probed.
  #
  # %{"ids" => [...]}: the pile list's rows on screen, in ONE request (the
  # DataLoader pattern). Still one allowance PER NAME — a batch must not
  # make scraping cheaper. Out of budget mid-batch: the rest come back as
  # `later` with `retry_ms`, the exact wait, so the app keeps one queue and
  # one timer (priv/static/reveal_queue.js).
  defp route("reveal", %{"ids" => ids}, socket) when is_list(ids) do
    ids = Enum.uniq(ids)

    if length(ids) > reveal_max() do
      {:reply, {:error, %{reason: "too_many"}}, socket}
    else
      {:reply, {:ok, reveal_batch(ids, socket)}, socket}
    end
  end

  defp route("reveal", payload, socket) do
    case Hoodride.RateBudget.spend(socket, :sync, @sync_per_minute, @sync_burst) do
      {:deny, socket} ->
        {:reply, {:error, %{reason: "rate_limited", retry_ms: reveal_wait(socket)}}, socket}

      {:ok, socket} ->
        {:reply, reveal(payload, socket), socket}
    end
  end

  # read-only otherwise: refused, never a crash
  defp route(_event, _payload, socket) do
    {:reply, {:error, %{reason: "read_only"}}, socket}
  end

  defp reveal(%{"id" => id}, socket) when is_integer(id) do
    role = Roles.of(socket.assigns.user_id)

    if visible?(id, role, socket) do
      case Hoodride.Accounts.profile(id) do
        %{} = u -> {:ok, revealed(u, role)}
        # the database couldn't answer right now — NOT gone: "unavailable"
        # reads "Not available" for good, so say when to ask again
        {:error, :unavailable} -> {:error, %{reason: "busy", retry_ms: busy_wait_ms()}}
        nil -> {:error, %{reason: "unavailable"}}
      end
    else
      {:error, %{reason: "unavailable"}}
    end
  end

  defp reveal(_payload, _socket), do: {:error, %{reason: "unavailable"}}

  # may this role see `id`'s marker on this screen right now? (in memory)
  defp visible?(id, role, socket) when is_integer(id) do
    case marker_topic(role, id) do
      topic when is_binary(topic) -> MapSet.member?(socket.assigns.held, topic)
      _ -> false
    end
  end

  defp visible?(_id, _role, _socket), do: false

  @doc "How long to wait before asking again when the database couldn't answer (Hoodride.Accounts.retry_wait_ms/0)."
  def busy_wait_ms, do: Hoodride.Accounts.retry_wait_ms()

  defp reveal_batch(ids, socket) do
    role = Roles.of(socket.assigns.user_id)

    # 1. each name, in order, exactly as a single reveal: one allowance
    #    (once refused, the rest wait too — first in line next time), then
    #    the privacy check. Both in memory.
    {allowed, refused, later} =
      Enum.reduce(ids, {[], [], []}, fn id, {allowed, refused, later} ->
        cond do
          later != [] or not name_fits?(socket) -> {allowed, refused, [id | later]}
          visible?(id, role, socket) -> {[id | allowed], refused, later}
          true -> {allowed, [id | refused], later}
        end
      end)

    {allowed, refused, later} =
      {Enum.reverse(allowed), Enum.reverse(refused), Enum.reverse(later)}

    # 2. the allowed names: ONE lookup (it used to be one per name). The
    #    database unable to answer: all of them wait, with its own patience.
    case Hoodride.Accounts.profiles(allowed) do
      {:ok, people} ->
        {found, gone} = Enum.split_with(allowed, &Map.has_key?(people, &1))
        users = for id <- found, u = people[id], do: revealed(u, role)
        answer(ids, users, refused ++ gone, later, reveal_wait(socket))

      {:error, :unavailable} ->
        answer(ids, [], refused, allowed ++ later, max(busy_wait_ms(), reveal_wait(socket)))
    end
  end

  # what a name lookup tells: name and photo — and, for a RIDER looking at a
  # car, that car ("Gray Honda Civic"; nil when none is set). A driver
  # looking at a ✋ never gets a car, even one that rider set once
  # (ARCHITECTURE.md "Your car").
  defp revealed(u, :viewer),
    do: %{
      id: u.id,
      name: u.name,
      photo: u.photo,
      car: Hoodride.Accounts.car_label(u),
      car_parts: Hoodride.Accounts.car_parts(u)
    }

  defp revealed(u, _role), do: %{id: u.id, name: u.name, photo: u.photo}

  # unavailable in the order asked; `retry_ms` only when something waits
  defp answer(ids, users, unavailable, later, wait) do
    out = MapSet.new(unavailable)
    answer = %{users: users, unavailable: Enum.filter(ids, &(&1 in out)), later: later}
    if later == [], do: answer, else: Map.put(answer, :retry_ms, wait)
  end

  # one name = one allowance, the same as a single reveal
  defp name_fits?(socket),
    do: match?({:ok, _}, Hoodride.RateBudget.spend(socket, :sync, @sync_per_minute, @sync_burst))

  defp reveal_wait(socket),
    do: max(Hoodride.RateBudget.wait_ms(socket, :sync, @sync_per_minute, @sync_burst), 1)

  # the topic `id`'s marker is on, for the layer this role receives (the
  # LIVE role: a "yes" for a layer this channel no longer holds can't count)
  defp marker_topic(:driver, id) do
    with cell when is_binary(cell) <- Geo.hand_cell(id), do: Geo.geo_topic(:hands, cell)
  end

  defp marker_topic(:viewer, id) do
    with cell when is_binary(cell) <- Geo.driver_cell(id), do: Geo.geo_topic(:drivers, cell)
  end

  defp marker_topic(_role, _id), do: nil

  defp reconcile(payload, socket) do
    want_geo = desired(payload, "geo")
    want_agg = desired(payload, "agg")

    # the cap is checked on the desired set BEFORE anything changes
    if MapSet.size(want_geo) + MapSet.size(want_agg) > @max_watch do
      {:reply, {:error, %{reason: "watch_limit"}}, socket}
    else
      # the role is re-derived on every sync (a lost ping heals here)
      role = Roles.of(socket.assigns.user_id)
      socket = assign(socket, role: role)
      want = topics(want_geo, want_agg, role)
      held = socket.assigns.held

      # drop what is no longer wanted (or no longer allowed) FIRST
      Enum.each(MapSet.difference(held, want), &Phoenix.PubSub.unsubscribe(Hoodride.PubSub, &1))

      # then add only what is new — a topic already held is never subscribed
      # twice (a duplicate subscription would deliver every update twice)
      new = MapSet.difference(want, held) |> Enum.sort()
      Enum.each(new, &Phoenix.PubSub.subscribe(Hoodride.PubSub, &1))

      # snapshots are taken AFTER subscribing: any update landing meanwhile
      # is queued in this process and delivered after the reply. Each one
      # carries only its own layer.
      {:reply, {:ok, snapshots(new)}, assign(socket, geo: want_geo, agg: want_agg, held: want)}
    end
  end

  # the topics a role may hold for the wished cells
  defp topics(geo, agg, role) do
    case Roles.layer(role) do
      nil ->
        MapSet.new()

      layer ->
        MapSet.union(
          MapSet.new(geo, &Geo.geo_topic(layer, &1)),
          MapSet.new(agg, &Geo.agg_topic(layer, &1))
        )
    end
  end

  defp snapshots(new_topics) do
    Enum.reduce(new_topics, %{geo: [], agg: []}, fn topic, acc ->
      case parse(topic) do
        {:geo, layer, cell} ->
          snap = Geo.cell_snapshot(cell)
          %{acc | geo: [%{:cell => cell, layer => Map.fetch!(snap, layer)} | acc.geo]}

        {:agg, layer, cell} ->
          counts = Geo.agg_counts_for(cell)
          %{acc | agg: [%{:cell => cell, layer => Map.fetch!(counts, layer)} | acc.agg]}
      end
    end)
    |> Map.new(fn {k, v} -> {k, Enum.reverse(v)} end)
  end

  defp parse("geo:d:" <> cell), do: {:geo, :drivers, cell}
  defp parse("geo:h:" <> cell), do: {:geo, :hands, cell}
  defp parse("agg:d:" <> cell), do: {:agg, :drivers, cell}
  defp parse("agg:h:" <> cell), do: {:agg, :hands, cell}

  defp layer_of(topic), do: topic |> parse() |> elem(1)

  # someone's role may have changed: re-derive, drop what it may no longer
  # hold, tell the app (it clears the layer and resyncs)
  @impl true
  def handle_info(%Phoenix.Socket.Broadcast{topic: "role:" <> _}, socket) do
    {:noreply, apply_role(socket, Roles.of(socket.assigns.user_id))}
  end

  # a watched topic's broadcast arrives in OUR mailbox — forward it on, but
  # only if the LIVE role still allows its layer (a message queued before a
  # role ping must not slip through)
  def handle_info(
        %Phoenix.Socket.Broadcast{topic: topic, event: event, payload: payload},
        %{assigns: %{batch_ms: 0}} = socket
      ) do
    role = Roles.of(socket.assigns.user_id)

    if Roles.layer(role) == layer_of(topic) do
      # the app gets the update itself; `json` is its one-time encoding (Geo)
      push(socket, event, Map.delete(payload, :json))
      {:noreply, socket}
    else
      {:noreply, apply_role(socket, role)}
    end
  end

  # batching on: held for its layer if that's the layer this channel holds
  # (the LIVE role is checked once, when the batch is sent)
  def handle_info(%Phoenix.Socket.Broadcast{topic: topic, event: event, payload: payload}, socket) do
    layer = layer_of(topic)

    if layer == Roles.layer(socket.assigns.role) do
      {:noreply, hold(socket, topic, layer, event, payload)}
    else
      {:noreply, apply_role(socket, Roles.of(socket.assigns.user_id))}
    end
  end

  def handle_info(:flush_map, socket),
    do: {:noreply, flush(%{socket | assigns: %{socket.assigns | flush_timer: nil}})}

  def handle_info(_other, socket), do: {:noreply, socket}

  # the user channel on the same socket asking before a cold contact: "is
  # this topic on your screen right now?" (HoodrideWeb.Reach). Never calls back.
  @impl true
  def handle_call({:holding?, topic}, _from, socket) do
    {:reply, MapSet.member?(socket.assigns.held, topic), socket}
  end

  defp apply_role(socket, role) when role == socket.assigns.role, do: socket

  defp apply_role(socket, role) do
    layer = Roles.layer(role)
    {keep, drop} = Enum.split_with(socket.assigns.held, &(layer_of(&1) == layer))
    Enum.each(drop, &Phoenix.PubSub.unsubscribe(Hoodride.PubSub, &1))
    pending = Map.filter(socket.assigns.pending, fn {_key, {_seq, l, _e, _p}} -> l == layer end)
    push(socket, "role", %{role: role_name(role)})
    assign(socket, role: role, held: MapSet.new(keep), pending: pending)
  end

  # THE MAP BATCH (:map_batch_ms, 0 = off). Socket writes are the biggest
  # cost at scale (ARCHITECTURE.md "Capacity"), so a channel may hold its
  # live updates for a moment and send them as ONE "batch" frame:
  #   - only the newest message per car / hand / count survives (a car that
  #     moved twice, or moved and left, sends only its latest); different
  #     ones keep their order. One car's messages all come from its one map
  #     writer, so they arrive here in the order they happened.
  #   - its OWN timer, started by the first held message — never a shared
  #     clock, which would make every channel send at the same instant
  #   - before any reply or "role", everything held goes out (flush/1)
  #   - privacy: the LIVE role is checked once, at send time; a role change
  #     drops what's held for the lost layer (apply_role/2)
  #   - each update arrives ENCODED ONCE (`json`, by the map writer — Geo):
  #     it goes into the frame as-is, never re-encoded per watcher (that
  #     was ~36% of a map channel's time under load)
  # Cars are shown as ~170 m spots, which a car at 36 km/h crosses in
  # 17-35 s, so a window of a second or two moves no marker visibly later.
  #
  # One message, one state update: this runs for every update to every
  # watcher, so the assigns are rewritten once (assign/2 merges three times).
  defp hold(%{assigns: assigns} = socket, topic, layer, event, payload) do
    seq = assigns.seq + 1
    item = if assigns.encode_once, do: payload.json, else: Map.delete(payload, :json)
    pending = Map.put(assigns.pending, item_key(topic, layer, payload), {seq, layer, event, item})
    timer = assigns.flush_timer || Process.send_after(self(), :flush_map, assigns.batch_ms)
    %{socket | assigns: %{assigns | pending: pending, seq: seq, flush_timer: timer}}
  end

  # one entry per car / hand (whatever cell it's in), one per count cell
  defp item_key("agg:" <> _ = topic, layer, _payload), do: {:agg, layer, topic}
  defp item_key(_geo_topic, layer, payload), do: {layer, payload.id}

  defp flush(%{assigns: %{pending: pending}} = socket) when map_size(pending) == 0,
    do: cancel_flush(socket)

  defp flush(socket) do
    socket = socket |> cancel_flush() |> apply_role(Roles.of(socket.assigns.user_id))

    items =
      socket.assigns.pending
      |> Map.values()
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.map(fn {_seq, _layer, event, item} -> [event, wire_item(item)] end)

    if items != [], do: push(socket, "batch", %{items: items})
    assign(socket, pending: %{})
  end

  # already encoded once (Geo), or (:map_encode_once false) encoded here
  defp wire_item(json) when is_binary(json), do: Jason.Fragment.new(json)
  defp wire_item(payload), do: payload

  defp cancel_flush(%{assigns: %{flush_timer: nil}} = socket), do: socket

  defp cancel_flush(socket) do
    Process.cancel_timer(socket.assigns.flush_timer)
    assign(socket, flush_timer: nil)
  end

  defp role_name(:viewer), do: "viewer"
  defp role_name(:driver), do: "driver"
  defp role_name(:in_ride), do: "in_ride"

  # any JSON shape tolerated; cells are opaque strings, size-capped, deduped
  defp desired(payload, key) when is_map(payload) do
    case Map.get(payload, key) do
      cells when is_list(cells) ->
        for c <- cells, is_binary(c), byte_size(c) <= @max_cell_bytes, into: MapSet.new(), do: c

      _ ->
        MapSet.new()
    end
  end

  defp desired(_payload, _key), do: MapSet.new()
end
