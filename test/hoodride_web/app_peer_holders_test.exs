defmodule HoodrideWeb.AppPeerHoldersTest do
  @moduledoc """
  The guard on forgetting people (owner, 2026-11-19). The app drops a
  person's record (realPeersById) once nothing points at it for a quiet
  minute — and "nothing points at it" is a hand-written list, peerInUse()
  in priv/static/app.js. A new screen that holds on to a person but isn't
  in that list would keep a stale copy of them (a name that no longer
  updates). This reads app.js and finds every long-lived holder of a
  person — the page's own top-level variables and state's fields — by the
  app's own ways of holding one:

    * a top-level variable named …Peer (bannerPeer);
    * a state field named …Peer (state.cardPeer, state.chatPeer);
    * anything assigned an object with a `peer` in it (blockAsk, state.ride);
    * a map keyed by a person (chats.set(peer, …));
    * a map, list or set a person is put IN (xById.set(id, peer),
      list.push(peer), set.add(peer)) — or an object holding one;
    * a page-level variable set to a person (endArmed = peer).

  Each must be named — as a whole word — in peerInUse(), or be in
  @not_people with why. What a regex can't see: a person held only by a
  closure (a listener, a timer, a reply on its way) — those must end
  within the quiet minute (every push reply does: 10 s; a chat's load:
  20 s), or the person must be held by one of the above.
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")

  # matched by the patterns, but not a person's holder — each with why
  @not_people %{
    "realPeersById" => "the records themselves (what's being forgotten)",
    "aggData" => "map counts by hex: `p` there is a hex's count, not a person",
    "demoBlocked" => "the demo's pretend people — never in realPeersById"
  }

  defp in_use_body do
    [_, body] = Regex.run(~r/function peerInUse\(p\) \{(.*?)\n\}/s, @app)
    body
  end

  defp uniq(matches), do: matches |> Enum.map(&List.last/1) |> Enum.uniq()

  # named in the body as a whole word (state.chat must not pass as state.chatPeer)
  defp named?(body, name),
    do: Regex.match?(~r/(?<![\w.])#{Regex.escape(name)}(?![\w])/, body)

  defp holders do
    # long-lived: the page's own top-level variables, and state's fields — a
    # function's local (`let entry = { peer, … }`, then put in a map) isn't
    top_level = uniq(Regex.scan(~r/^(?:let|const) ([A-Za-z_]+)\b/m, @app))
    long_lived? = &(String.starts_with?(&1, "state.") or &1 in top_level)

    named_peer =
      uniq(Regex.scan(~r/^(?:let|const) ([A-Za-z_]*Peer)\b/m, @app)) ++
        uniq(Regex.scan(~r/(state\.[A-Za-z_]*Peer)\s*=[^=]/, @app))

    with_a_peer =
      Regex.scan(~r/(?:^|[^.\w])((?:state\.)?[A-Za-z_]+)\s*=\s*\{[^{}]*\bpeer\b/m, @app)
      |> uniq()
      |> Enum.filter(long_lived?)

    keyed_by_person = uniq(Regex.scan(~r/\b([A-Za-z_]+)\.set\(peer\s*,/, @app))

    holding_people =
      (Regex.scan(~r/\b([A-Za-z_]+)\.set\([^,()]+,\s*(?:peer|p)\s*\)/, @app) ++
         Regex.scan(~r/\b([A-Za-z_]+)\.(?:push|add)\((?:peer|p)\)/, @app) ++
         Regex.scan(~r/\b([A-Za-z_]+)\.(?:push|add)\(\{[^}]*\bpeer\b/, @app) ++
         Regex.scan(~r/\b([A-Za-z_]+)\.set\([^,()]+,\s*\{[^}]*\bpeer\b/, @app) ++
         Regex.scan(~r/(?:^|[^.\w])((?:state\.)?[A-Za-z_]+)\s*=\s*(?:peer|p)\s*;/m, @app))
      |> uniq()
      |> Enum.filter(long_lived?)

    %{
      plain: Enum.uniq(named_peer ++ with_a_peer ++ holding_people) -- Map.keys(@not_people),
      keyed: keyed_by_person -- Map.keys(@not_people)
    }
  end

  test "every long-lived holder of a person is in peerInUse()" do
    body = in_use_body()
    %{plain: plain, keyed: keyed} = holders()

    # (what the patterns find today: if these vanish, the patterns broke —
    # not the app)
    for h <- ~w(bannerPeer state.cardPeer state.chatPeer blockAsk state.ride),
        do: assert(h in plain, "the patterns no longer find #{h}")

    assert "chats" in keyed

    missing =
      Enum.reject(plain, &named?(body, &1)) ++
        Enum.reject(keyed, &String.contains?(body, "#{&1}.has(p)"))

    assert missing == [],
           "these hold a person but aren't in peerInUse() (priv/static/app.js) — " <>
             "add them there (or to @not_people here, with why), or the person can be " <>
             "forgotten while still shown: #{inspect(missing)}"
  end

  test "the people on the map count too (realEntries, by id)" do
    assert in_use_body() =~ "realEntries.has(p.id)"
  end

  test "every exception is still there to be excepted (none stale)" do
    for {name, _why} <- @not_people,
        do: assert(@app =~ name, "#{name}: gone from app.js — drop it here")
  end
end
