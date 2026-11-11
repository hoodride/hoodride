defmodule HoodrideWeb.NearCoversTest do
  @moduledoc """
  (Besides the box rule below, this file pins — line by line, in order — the
  rest of find the nearest's code: where it starts (closer in on a big
  screen; none on a counts-only one), waiting for the drawn answer and
  behind drawers, the screen changing size, errors ending it cleanly, and
  what it said staying true over time: the found watch and its back-off,
  500 m moved (outward only: the map never zooms in by itself), the two
  clocks, "Use here". Its
  journeys: test_browser/findnearest*.mjs.)

  Find the nearest counts only people you can see: "if you can see it on the
  map, it counts" (owner, 2026-11-09 — the box rule, HoodNearby.inSight,
  test_js/nearby.test.mjs; the journeys test_browser/findnearestcover*.mjs
  run it). app.js is glue the Node tests can't load, so this reads the files:

    * every element on the map screen is either on the covers list or named
      here as not counted, with why — a new one can't be forgotten (found by
      walking the page's tags, not by its layout); a removed one leaves no
      stale entry;
    * a cover is what you SEE — never a see-through row stretched across the
      screen (the bottom bar's buttons count one by one, not the row);
    * covers, the screen and the markers are measured at every check — the
      search and "nobody nearby yet" alike, through the same rule; only
      markers the map has drawn count, each its own size (a group's "+N"
      badge included);
    * "nobody nearby yet" is looked at again once a second while it shows,
      never cleared while the map is out of sight, and clears when what you
      look for changes;
    * the map never turns or tilts (the maths is north-up, flat).
  """
  use ExUnit.Case, async: true

  @app File.read!("priv/static/app.js")
  @html File.read!("priv/static/index.html")
  @css File.read!("priv/static/styles.css")

  # on the map screen, but not over the map while anyone looks at it
  @not_counted %{
    "map" => "the map itself",
    "class:topbar" =>
      "the top bar: a see-through fade — what's on it is counted (btn-account, .topbar-title, btn-mode)",
    "bottom-controls" =>
      "the bottom bar: a see-through row across the screen — its buttons are counted one by one",
    "settings-backdrop" => "Settings: a drawer with its own backdrop (the map is out of sight)",
    "settings-sheet" => "Settings: a drawer (mapOutOfSight — open, or still sliding away)",
    "nav-backdrop" => "the navigation app choice: a dialog with its own backdrop",
    "nav-sheet" => "the navigation app choice: a dialog (mapOutOfSight)",
    "car-backdrop" => "the car form: a dialog with its own backdrop",
    "car-sheet" => "the car form: a dialog (mapOutOfSight)",
    # straight in <body>
    "lang-backdrop" => "the language choice: a dialog with its own backdrop",
    "lang-sheet" => "the language choice: a dialog (mapOutOfSight)",
    # added by the app itself (document.body.appendChild)
    "session-moved" => "the \"Use here\" cover: over the whole map (mapOutOfSight)",
    "nameless:area" => "the copy helper: an invisible text box, removed the moment it's used",
    "safe-probe" =>
      "never seen: its padding is the phone's safe-area insets — counted as covers (nearCovers)"
  }

  @covers [
    "#btn-account",
    ".topbar-title",
    "#btn-mode",
    "#banner",
    "#update-available",
    "#btn-locate",
    "#bottom-controls > *",
    "#share-location",
    "#peer-card",
    "#pile-sheet",
    "#chat",
    ".maplibregl-ctrl"
  ]

  # (and the later FOUND_GONE_MS: the watch's wait is the back-off now)
  @removed ~w(nearPad coverPad fitZoom NEAR_PAD NEAR_MARGIN NEAR_SIDES FOUND_GONE_MS NOBODY_STALE_MS nobodySince nearbyBack NEAR_AWAY_MS)

  defp body(fun) do
    [b] = Regex.run(~r/function #{fun}\(.*?\n}\n/s, @app)
    b
  end

  defp covers do
    [list] = Regex.run(~r/const NEAR_COVERS = \[(.*?)\];/s, @app, capture: :all_but_first)
    Regex.scan(~r/"([^"]+)"/, list, capture: :all_but_first) |> Enum.map(&hd/1)
  end

  # the screen element each cover entry stands for: "#id" → id,
  # "#id > *" → id's children (the row itself isn't one)
  defp covered_ids, do: for("#" <> rest <- covers(), do: rest |> String.split(" ") |> hd())

  @void ~w(img input br hr meta link source area col wbr)

  # the map screen's own elements — its direct children — by walking the
  # tags (any attribute order, any indent; comments skipped): an id, else
  # "class:<first class>", else "tag:<tag>"
  defp screen_children, do: children(~s(<section id="screen-map"), "</section>")

  # the direct children of the element whose opening tag starts with `open`
  # (up to the first `close` after it — the element's own closing tag)
  defp children(open, close) do
    {start, _} = :binary.match(@html, open)
    {stop, _} = :binary.match(@html, close, scope: {start, byte_size(@html) - start})
    section = binary_part(@html, start, stop - start) |> String.replace(~r/<!--.*?-->/s, "")

    Regex.scan(~r/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/s, section, capture: :all_but_first)
    |> Enum.reduce({[], 0}, fn [close, tag, attrs, self], {acc, depth} ->
      if close == "/" do
        {acc, depth - 1}
      else
        acc = if depth == 1, do: [key(tag, attrs) | acc], else: acc
        leaves = self == "/" or String.downcase(tag) in @void
        {acc, if(leaves, do: depth, else: depth + 1)}
      end
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp key(tag, attrs) do
    case {Regex.run(~r/\bid="([^"]+)"/, attrs), Regex.run(~r/\bclass="([^" ]+)/, attrs)} do
      {[_, id], _} -> id
      {nil, [_, class]} -> "class:" <> class
      _ -> "tag:" <> String.downcase(tag)
    end
  end

  # what the app adds to the page itself: the id given to each element it
  # appends to <body> (in the lines before), else "nameless:<variable>"
  defp added_by_code do
    Regex.scan(~r/document\.body\.appendChild\((\w+)\)/, @app,
      return: :index,
      capture: :all_but_first
    )
    |> Enum.map(fn [{at, len}] ->
      var = binary_part(@app, at, len)
      before = binary_part(@app, max(at - 2000, 0), min(at, 2000))

      case Regex.scan(~r/\b#{var}\.id = "([^"]+)";/, before, capture: :all_but_first) do
        [] -> "nameless:" <> var
        found -> found |> List.last() |> hd()
      end
    end)
  end

  defp exists?(id), do: @html =~ ~s(id="#{id}") or @app =~ ~s(.id = "#{id}";)

  # the CSS rules that style an element: its id's, and its classes'
  defp rules_for(id) do
    classes =
      case Regex.run(~r/id="#{id}"[^>]*class="([^"]+)"|class="([^"]+)"[^>]*id="#{id}"/, @html) do
        [_, a] -> String.split(a)
        [_, "", b] -> String.split(b)
        _ -> []
      end

    sels = ["#" <> id | Enum.map(classes, &("." <> &1))]

    for sel <- sels,
        [rule] <-
          Regex.scan(~r/(?:^|\n)#{Regex.escape(sel)}\s*\{([^}]*)\}/, @css,
            capture: :all_but_first
          ),
        do: rule
  end

  test "the page walk finds the map screen's elements (it isn't trivially empty)" do
    kids = screen_children()
    assert "map" in kids and "banner" in kids and "chat" in kids and "class:topbar" in kids
    assert "bottom-controls" in kids and "btn-locate" in kids
    assert length(kids) >= 14, inspect(kids)
  end

  test "the covers list is exactly what you see over the map" do
    assert covers() == @covers
  end

  test "every element on the map screen: covering, or not counted for a reason" do
    for k <- screen_children() do
      assert k in covered_ids() or Map.has_key?(@not_counted, k),
             "#{k} is on the map screen but neither covers the map (NEAR_COVERS) nor is named as not counted"
    end

    # the map's credits button (the compact "i" in the corner) is drawn —
    # one of the map's own controls, all counted (.maplibregl-ctrl)
    assert body("initMap") =~ "attributionControl: { compact: true },"
  end

  test "what sits on the see-through top bar: every one of its things is counted" do
    # its two sides, and what's on each (a new button there can't be missed)
    assert children(~s(<header class="topbar"), "</header>") == [
             "class:topbar-left",
             "class:topbar-right"
           ]

    assert children(~s(<div class="topbar-left">), "</div>\n      <div class=\"topbar-right\">") ==
             ["btn-account", "class:topbar-title"]

    assert children(~s(<div class="topbar-right">), "</header>") == ["btn-mode"]
    for k <- ["btn-account", "btn-mode"], do: assert(k in covered_ids())
    assert ".topbar-title" in covers()
  end

  # the page's own top level, besides its three screens: anything placed
  # straight in <body> sits over the map too
  @body_ok ~w(screen-login screen-terms screen-map tag:script tag:noscript)
  test "every element straight in <body> (outside the three screens): covering, or not counted for a reason" do
    kids = children("<body", "</body>")
    assert "screen-map" in kids and "lang-sheet" in kids, inspect(kids)

    for k <- kids, k not in @body_ok do
      assert k in covered_ids() or Map.has_key?(@not_counted, k),
             "#{k} sits straight in <body> but neither covers the map (NEAR_COVERS) nor is named as not counted"
    end
  end

  test "the app puts things on the page only the way the walk sees (document.body.appendChild(x)) — never another way into <body> or the map screen" do
    for pat <- [
          ~r/document\.body\.(append|prepend|insertBefore|insertAdjacentElement|insertAdjacentHTML|replaceChildren)\(/,
          ~r/document\.body\.(innerHTML|outerHTML)\s*[+]?=/,
          ~r/(\$\("screen-map"\)|getElementById\("screen-map"\))\.(append|appendChild|prepend|insertBefore|insertAdjacent\w*|replaceChildren)\(/,
          ~r/(\$\("screen-map"\)|getElementById\("screen-map"\))\.innerHTML\s*[+]?=/
        ] do
      refute @app =~ pat,
             "the app adds to the page a way the covers walk can't see: #{inspect(Regex.run(pat, @app))}"
    end
  end

  test "every element the app adds to the page itself: covering, or not counted for a reason" do
    added = added_by_code()

    assert "update-available" in added and "share-location" in added and "session-moved" in added,
           inspect(added)

    for k <- added do
      assert k in covered_ids() or Map.has_key?(@not_counted, k),
             "the app adds #{k} to the page but it neither covers the map (NEAR_COVERS) nor is named as not counted"
    end
  end

  test "every name on the lists still exists — a removed element leaves no stale entry (or a crash)" do
    for id <- covered_ids(),
        do: assert(exists?(id), "NEAR_COVERS lists ##{id}, which no longer exists")

    # (the map's controls are the map library's)
    for "." <> class <- covers(), class != "maplibregl-ctrl" do
      assert @html =~ ~r/class="[^"]*\b#{class}\b/,
             "NEAR_COVERS lists .#{class}, which no longer exists"
    end

    for k <- Map.keys(@not_counted) do
      cond do
        String.starts_with?(k, "class:") or String.starts_with?(k, "tag:") ->
          assert k in screen_children(),
                 "#{k} is named as not counted but is no longer on the map screen"

        String.starts_with?(k, "nameless:") ->
          assert k in added_by_code(),
                 "#{k} is named as not counted but the app no longer adds it"

        true ->
          assert exists?(k), "#{k} is named as not counted but no longer exists"
      end
    end

    # mapOutOfSight reads these by name: one gone would break it
    [ids] =
      Regex.run(~r/\[("car-sheet"[^\]]*)\]\.some/, body("mapOutOfSight"), capture: :all_but_first)

    for [id] <- Regex.scan(~r/"([^"]+)"/, ids, capture: :all_but_first) ++ [["settings-sheet"]] do
      assert @html =~ ~s(id="#{id}"), "mapOutOfSight reads #{id}, which no longer exists"
    end
  end

  test "a cover is what you see — never a see-through row stretched across the screen" do
    # the check itself: the bottom bar's row IS such a row (it's why its
    # buttons count one by one)
    row = Enum.join(rules_for("bottom-controls"))
    assert row =~ "left: 0;" and row =~ "right: 0;" and row =~ "pointer-events: none;"

    for id <- covered_ids(),
        not String.contains?(Enum.find(covers(), &String.starts_with?(&1, "##{id}")), " ") do
      css = Enum.join(rules_for(id))

      refute css =~ "pointer-events: none;",
             "##{id} lets touches through to the map: a see-through box — count what's in it, not it"
    end
  end

  test "the phone's own edges (the notch, the status bar, the home bar) and what the visible area leaves out (the keyboard): covers too" do
    lines_in_order(
      body("nearCovers"),
      [
        "const inset = safeInsets();",
        "if (inset.top) strip(0, inset.top, 0, W);",
        "if (inset.bottom) strip(H - inset.bottom, H, 0, W);",
        "if (inset.left) strip(0, H, 0, inset.left);",
        "if (inset.right) strip(0, H, W - inset.right, W);",
        "const vv = window.visualViewport;",
        "if (vv.offsetTop > 0.5) strip(0, vv.offsetTop, 0, W);",
        "if (vv.offsetTop + vv.height < H - 0.5) strip(vv.offsetTop + vv.height, H, 0, W);",
        "if (vv.offsetLeft > 0.5) strip(0, H, 0, vv.offsetLeft);",
        "if (vv.offsetLeft + vv.width < W - 0.5) strip(0, H, vv.offsetLeft + vv.width, W);",
        "return covers;"
      ],
      "nearCovers"
    )

    lines_in_order(
      body("safeInsets"),
      [
        "const el = document.getElementById(\"safe-probe\");",
        "if (!el) return { top: 0, bottom: 0, left: 0, right: 0 };",
        "const cs = getComputedStyle(el);",
        "return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0 };"
      ],
      "safeInsets"
    )

    # the screen's own width and height (sideways they differ: a strip across
    # must reach the far edge)
    lines_in_order(
      body("nearCovers"),
      [
        "const W = window.innerWidth;",
        "const H = window.innerHeight;",
        "const strip = (top, bottom, left, right) => covers.push({ top: top - m.top, bottom: bottom - m.top, left: left - m.left, right: right - m.left });"
      ],
      "nearCovers: the screen"
    )

    lines_in_order(
      body("initMap"),
      ["probe.id = \"safe-probe\";", "document.body.appendChild(probe);"],
      "initMap"
    )

    [probe] = Regex.run(~r/\n#safe-probe \{([^}]*)\}/, @css, capture: :all_but_first)

    assert probe =~
             "padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);"

    assert probe =~ "visibility: hidden;" and probe =~ "pointer-events: none;"
  end

  test "the keyboard's area counts only while you type (iOS 26 reports a leftover one after it closes) — or the page pinched in" do
    lines_in_order(
      body("nearCovers"),
      [
        "const vv = window.visualViewport;",
        "const field = document.activeElement;",
        ~s{const typing = !!field && !field.closest(".hidden") && field.matches("input, textarea, select, [contenteditable]:not([contenteditable='false'])");},
        "if (vv && (typing || vv.scale > 1.01)) {"
      ],
      "nearCovers: the keyboard"
    )
  end

  test "no cover is ever hidden by fading it out (only .hidden is skipped: a faded box would still count)" do
    # every name a cover is styled by: its id and, for "#id" entries, the
    # classes the page gives it ("#bottom-controls > *": its children's)
    names =
      for sel <- @covers,
          String.starts_with?(sel, "#") or String.starts_with?(sel, "."),
          reduce: [] do
        acc ->
          name = sel |> String.split(" ") |> hd()

          classes =
            case name do
              "#bottom-controls" ->
                [section] = Regex.run(~r/<div id="bottom-controls".*?\n    <\/div>/s, @html)

                for [c] <- Regex.scan(~r/class="([^"]+)"/, section, capture: :all_but_first),
                    k <- String.split(c),
                    do: "." <> k

              "#" <> id ->
                case Regex.run(
                       ~r/id="#{id}"[^>]*class="([^"]+)"|class="([^"]+)"[^>]*id="#{id}"/,
                       @html
                     ) do
                  [_, a] -> Enum.map(String.split(a), &("." <> &1))
                  [_, "", b] -> Enum.map(String.split(b), &("." <> &1))
                  _ -> []
                end

              _ ->
                []
            end

          acc ++ [name | classes]
      end
      |> Enum.uniq()
      |> Enum.reject(&(&1 in [".hidden", ".btn", ".btn-pill", ".btn-small"]))

    assert ".btn-locate" in names and ".pile-sheet" in names and ".banner" in names,
           inspect(names)

    for name <- names,
        # (a selector list may run over several lines)
        [rule] <-
          Regex.scan(~r/(?:^|\})[^{}]*#{Regex.escape(name)}(?![\w-])[^{}]*\{([^}]*)\}/, @css,
            capture: :all_but_first
          ) do
      refute rule =~ ~r/opacity\s*:\s*0(\.0*)?%?\s*(;|$)|visibility\s*:\s*hidden/m,
             "#{name} (a cover) is hidden by fading (opacity/visibility) somewhere — nearCovers would still count its box"
    end
  end

  test "covers measured where they are, at every check — showing ones only" do
    n = body("nearCovers")
    assert n =~ ~s[const m = $("map").getBoundingClientRect();]
    assert n =~ "for (const sel of NEAR_COVERS)"
    assert n =~ "for (const el of document.querySelectorAll(sel)) {"
    assert n =~ ~s[if (el.closest(".hidden")) continue;]
    assert n =~ "if (!b.width || !b.height) continue;"

    # (a solid ring round a cover — the raised ✋'s — grows its box)
    lines_in_order(
      n,
      [
        "const g = HoodNearby.ringReach(getComputedStyle(el));",
        "covers.push({ top: b.top - m.top - g, bottom: b.bottom - m.top + g, left: b.left - m.left - g, right: b.right - m.left + g });"
      ],
      "nearCovers: each cover with its ring"
    )
  end

  test "your blue dot is drawn under everyone (a car by you is never hidden by it) — added only through showMe" do
    lines_in_order(
      body("showMe"),
      ["meMarker.addTo(map);", "map.getCanvas().after(meMarker.getElement());"],
      "showMe"
    )

    # (however written: chained, or its element put on the page by hand)
    assert length(Regex.scan(~r/meMarker\b[^;\n]*\.addTo\(/, @app)) == 1,
           "the dot added somewhere other than showMe (it would land on top of cars)"

    refute @app =~ ~r/(append|appendChild|prepend|insertBefore|before)\(\s*meMarker/,
           "the dot's element put on the page by hand (it would land on top of cars)"

    assert @app =~ "  if (DEMO) showMe();"
    assert @app =~ "      if (first) showMe();"
  end

  test "\"nobody nearby yet\" in the banner only when it's about whom you look for now" do
    assert body("situationBanner") =~
             "const nobody = nobodyNear && nobodyType === HoodNearby.lookingFor(state);"
  end

  test "the search starts at the usual view — closer in on a screen so big it shows counts there" do
    f = body("findNearest")

    assert f =~
             "const startZoom = HoodNearby.markerStartZoom({ ...ladder, maxZoom: INTENT_ZOOM });"

    assert f =~
             "const widestZoom = HoodNearby.widestMarkerZoom({ ...ladder, maxZoom: startZoom });"

    assert f =~ "const all = HoodNearby.zoomSteps(startZoom, widestZoom, NEAR_STEP);"

    assert f =~
             "const ladder = { viewport: HoodViewport, h3, center: at, size: { w: size.w + 2 * NEAR_EDGE_PX, h: size.h + 2 * NEAR_EDGE_PX }, rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS };"
  end

  # (a look-again — not a tap — never closer in than the map is: owner,
  # 2026-11-10; test_browser/findnearestcover3b.mjs shows it)
  test "a screen that can't show people one by one at any zoom: no search, nothing said — but the map still comes to you" do
    f = body("findNearest")

    assert f =~
             "if (!HoodNearby.showsMarkers(HoodViewport, h3, HoodNearby.screenAt(at, startZoom, ladder.size), ladder.rungs, ladder.budget)) {\n    map.easeTo({ center: [at.lng, at.lat], zoom: outFrom === null ? startZoom : Math.min(startZoom, map.getZoom()) });\n    return;\n  }"

    {skip, _} = :binary.match(f, "if (!HoodNearby.showsMarkers(")
    {looking, _} = :binary.match(f, "nearLooking = true;")
    assert skip < looking, "decided before the search starts looking"
  end

  test "the screen changing size mid-search ends it (its steps were worked out for the old size) — as the map's own resize does when still" do
    f = body("findNearest")
    assert f =~ "const now = mapSize();"
    assert f =~ "if (now.w !== size.w || now.h !== size.h) return stopFindNearest();"
    {seq, _} = :binary.match(f, "if (seq !== nearSeq) return;")

    {resized, _} =
      :binary.match(f, "if (now.w !== size.w || now.h !== size.h) return stopFindNearest();")

    {look, _} = :binary.match(f, "if (anyone(steps[i])) {")
    assert seq < resized and resized < look
  end

  test "opening, and the locate button when not looking: the usual view — closer in where it shows counts" do
    u = body("usualZoom")

    assert u =~
             "return HoodNearby.markerStartZoom({ viewport: HoodViewport, h3, center: at, size: mapSize(), rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS, maxZoom: INTENT_ZOOM });"

    assert @app =~ "else map.easeTo({ center: [pos.lng, pos.lat], zoom: usualZoom(pos) });"

    assert body("centreOnYou") =~
             "else map.easeTo({ center: [at.lng, at.lat], zoom: Math.max(map.getZoom(), 15, usualZoom(at)) });"
  end

  test "the search waits for the answer to be DRAWN, and while the map is out of sight" do
    f = body("findNearest")

    assert f =~
             "const answered = () => DEMO || (worldSync.settled() && serverRole === role && !renderMarkersSoon.pending());"

    assert @app =~
             "const renderMarkersSoon = HoodMapFrame.createFrameRender(() => renderRealMarkers(), (f) => requestAnimationFrame(f));"

    # in this order: still this search → still looking → refused → out of
    # sight (wait) → moving or unanswered (wait) → look
    order = [
      "if (seq !== nearSeq) return;",
      "if (HoodNearby.lookingFor(state) !== type) return stopFindNearest();",
      "if (!DEMO && worldSync.refused()) return stopFindNearest();",
      "if (mapOutOfSight()) return setTimeout(check, NEAR_HIDDEN_MS);",
      "if (map.isMoving() || !answered()) return setTimeout(check, 100);",
      "if (anyone(steps[i])) {"
    ]

    at = Enum.map(order, fn s -> f |> :binary.match(s) |> elem(0) end)
    assert at == Enum.sort(at), inspect(Enum.zip(order, at))
  end

  test "the search and \"nobody nearby yet\" count the same way: the same rule, the same boxes, measured each time" do
    f = body("findNearest")

    assert f =~
             "HoodNearby.anyoneAt({ me: at, people: peopleOnMap(type), size: mapSize(), covers: nearCovers(), zoom, half: NEAR_HALF })"

    a = body("nearbyArrived")
    assert a =~ "const size = mapSize();\n  const covers = nearCovers();"

    assert a =~
             "HoodNearby.inSight(map.project([p.pos.lng, p.pos.lat]), p.half || NEAR_HALF, size, covers)"

    assert a =~ "if (!peopleOnMap(type).some(clear)) return;
  setNobodyNear(false);"
  end

  test "only drawn markers count, where they're drawn, each its own reach — a group's badge included" do
    p = body("peopleOnMap")

    for line <- [
          "const el = marker.getElement();",
          "if (!el.isConnected) return [];",
          "const at = marker.getLngLat();",
          "return [{ pos: { lat: at.lat, lng: at.lng }, half: lazyReach(el) }];",
          ~s[if (type === "driver") return drivers.filter((d) => d.visible).flatMap((d) => drawn(d.marker));],
          "return mockHand && mockHand.visible ? drawn(mockHand.marker) : [];",
          "if (pm.type === type) out.push(...drawn(pm.marker));",
          "return out;"
        ],
        do: assert(p =~ line, "peopleOnMap: #{line}")

    refute p =~ "realEntries",
           "people must come from what's drawn (the groups), not the list of everyone known"

    refute p =~ ".pos,", "where a marker is DRAWN (getLngLat), not where the data says"

    # measured only when the rule asks (a marker whose middle is on the
    # screen), once
    z = body("lazyReach")
    assert z =~ "m = m || markerReach(el);"
    assert z =~ "return m[k] ?? m[xy];"

    for k <- [
          ~s[get l() { return get("l", "x"); }],
          ~s[get r() { return get("r", "x"); }],
          ~s|get ["t"]() { return get("t", "y"); }|,
          ~s[get b() { return get("b", "y"); }]
        ],
        do: assert(z =~ k, k)

    h = body("markerReach")
    assert h =~ "const b = el.getBoundingClientRect();"
    # (not laid out: nothing of it can be seen — a reach no rule accepts)
    assert h =~ "if (!b.width || !b.height) return { x: NaN, y: NaN };"

    assert h =~
             ~s{return HoodNearby.markerReach(b, [...el.querySelectorAll("*")].map((k) => k.getBoundingClientRect()));}

    # a single marker's half-size matches its drawn size (44 px)
    assert @app =~ "const NEAR_HALF = { x: 22, y: 22 };"
    [bubble] = Regex.run(~r/\n\.marker-bubble \{([^}]*)\}/, @css, capture: :all_but_first)
    assert bubble =~ "width: 44px;" and bubble =~ "height: 44px;"
  end

  test "\"nobody nearby yet\": once a second while it shows; never cleared out of sight; clears when what you look for changes" do
    s = body("setNobodyNear")
    assert s =~ "if (nobodyNear === on) return;"
    assert s =~ "nobodyType = on ? HoodNearby.lookingFor(state) : null;"
    assert s =~ "clearInterval(nobodyCheck);"
    assert s =~ "nobodyCheck = on ? setInterval(nearbyArrived, 1000) : null;"

    # in this order: not showing → what you look for changed → out of sight → in sight
    a = body("nearbyArrived")

    order = [
      "if (!nobodyNear) return;",
      "if (!type || type !== nobodyType) return setNobodyNear(false);",
      "if (mapOutOfSight()) return;",
      "if (!peopleOnMap(type).some(clear)) return;"
    ]

    at = Enum.map(order, fn s -> a |> :binary.match(s) |> elem(0) end)
    assert at == Enum.sort(at), inspect(Enum.zip(order, at))

    # the search ending takes the line down; markers redrawn look again
    assert body("stopFindNearest") =~ "setNobodyNear(false);"
    assert body("renderRealMarkers") =~ "nearbyArrived();"
    assert body("refreshWorldMarkers") =~ "nearbyArrived();"

    o = body("mapOutOfSight")

    assert o =~
             ~s[if (shown("settings-sheet", true) || onScreen("settings-sheet") || document.getElementById("session-moved")) return true;]

    # still sliding away: on the screen, and not yet hidden at the end of it
    assert o =~ ~s[if (!el || getComputedStyle(el).visibility === "hidden") return false;]
    assert o =~ "return b.right > 0.5 && b.left < window.innerWidth - 0.5 && b.width > 0;"

    # (a form gone from the page: not open — never an error)
    assert o =~
             "return !!el && (open ? el.classList.contains(\"open\") : !el.classList.contains(\"hidden\"));"

    assert o =~
             ~s{return ["car-sheet", "nav-sheet", "lang-sheet"].some((id) => shown(id, false));}
  end

  test "the old strip model (and the watch's old fixed wait) is gone everywhere — the app, the tests, the journeys" do
    files =
      Path.wildcard("priv/static/*.js") ++
        Path.wildcard("test_js/*.mjs") ++
        Path.wildcard("test_browser/*.mjs") ++
        (Path.wildcard("test/**/*.exs") -- [__ENV__.file |> Path.relative_to_cwd()])

    for f <- files, name <- @removed do
      refute File.read!(f) =~ ~r/\b#{name}\b/, "#{f} still uses #{name} (the old strip model)"
    end
  end

  test "people's markers are drawn CENTRED on their spot (the maths counts a marker's box around its middle)" do
    # no anchor, no offset: the map library's default is the middle (a
    # marker anchored at its bottom, like the meeting pin, would be drawn
    # 22 px higher than the search counts it)
    assert body("makePileMarker") =~
             "new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);"

    assert body("makeBubbleMarker") =~ "return new maplibregl.Marker({ element: el });"

    for f <- ["makePileMarker", "makeBubbleMarker"] do
      refute body(f) =~ "anchor", "#{f}: anchored off its middle"
      refute body(f) =~ "offset", "#{f}: moved off its middle"
    end
  end

  # each line a whole line of its own (never inside a comment: "// x();"
  # doesn't count), and in this order
  # (each found AFTER the one before it)
  defp lines_in_order(text, lines, what) do
    Enum.reduce(lines, 0, fn line, from ->
      rest = binary_part(text, from, byte_size(text) - from)

      case Regex.run(~r/^[ \t]*#{Regex.escape(line)}[ \t]*$/m, rest, return: :index) do
        [{i, len}] -> from + i + len
        _ -> flunk("#{what}: not a line of its own, in order — #{line}")
      end
    end)
  end

  # "Nobody nearby yet" and a search's find stay true over time (owner,
  # 2026-11-09): about where you are NOW, not where it once looked
  test "moved more than 500 m since the search answered ('nobody nearby yet', a find, or still looking): searched again from where you are — after an answer, outward from where the map is, the back-off afresh" do
    assert @app =~ ~r/^const NEAR_MOVED_M = 500;$/m
    # (behind a drawer, the search looks 4 times a second — battery)
    assert @app =~ ~r/^const NEAR_HIDDEN_MS = 250;$/m
    # (the zooms worked out for a screen 2 px bigger each side; never
    # "nobody" over counts)
    assert @app =~ ~r/^const NEAR_EDGE_PX = 2;$/m

    lines_in_order(
      body("findNearest"),
      [
        "const ladder = { viewport: HoodViewport, h3, center: at, size: { w: size.w + 2 * NEAR_EDGE_PX, h: size.h + 2 * NEAR_EDGE_PX }, rungs: [H3_RES, ...AGG_RESES], budget: MAX_WATCHED_CELLS };",
        "if (anyone(steps[i])) {",
        "if (!DEMO && worldSync.wantedAggSize() > 0 && worldSync.wantedGeoSize() === 0) {",
        "if (i === steps.length - 1) {"
      ],
      "findNearest: the margin, and never nobody over counts"
    )

    lines_in_order(body("setNobodyNear"), ["nobodyAt = on ? nearAt : null;"], "setNobodyNear")

    lines_in_order(
      body("nearbyMoved"),
      [
        "const from = nobodyNear ? nobodyAt : foundWatch || nearLooking ? nearAt : null;",
        "if (!from) return;",
        "if (HoodNearby.metersBetween(from, pos) <= NEAR_MOVED_M) return;",
        "if (nearLooking && !nearOutward) return findNearest(pos);",
        "researches = 0;",
        "findNearest(pos, { outFrom: map.getZoom() });"
      ],
      "nearbyMoved"
    )

    # every good reading of where you are — and remembered as having come
    [good] = Regex.run(~r/    onGood\(pos\) \{.*?\n    \},/s, @app)

    lines_in_order(
      good,
      ["state.me = pos;", "state.haveFix = true;", "goodSeen = true;", "nearbyMoved(pos);"],
      "onGood"
    )

    lines_in_order(
      body("findNearest"),
      ["stopFindNearest();", "nearOutward = outFrom !== null;", "nearAt = at;"],
      "findNearest"
    )

    # your own move cancels a ◎ tap still waiting for its reading (it won't
    # move the map back when it comes); ◎ looks from your last GOOD reading
    # (only YOUR drag or pinch cancels a ◎ tap still waiting — not the
    # app's own moves)
    assert @app =~ "    if (e.originalEvent && !DEMO) loc.cancelCentre();"
    refute body("movedByHand") =~ "cancelCentre"

    assert @app =~
             "  if (loc.tapLocate()) centreOnYou(HoodNearby.lookingFor(state) && goodSeen ? state.me : loc.best);"
  end

  test "looked again from where you are — the last good reading if there ever was one, else where it looked (never the app's starting placeholder)" do
    assert @app =~ ~r/^const nearFrom = \(\) => \(goodSeen \? state\.me : nearAt\);$/m
    assert @app =~ ~r/^let goodSeen = false;/m
  end

  test "the map never zooms in by itself: coming back to the app searches nothing (owner, 2026-11-10) — 'nobody nearby yet' isn't looked at in the background" do
    # (a found car in sight a whole minute: the back-off starts over)
    assert @app =~ ~r/^const NEAR_SETTLED_MS = 60000;$/m
    # (…a gap in the watch's once-a-second looks — a phone locked, a laptop
    # asleep — breaks that minute)
    assert @app =~ ~r/^const NEAR_LOOK_GAP_MS = 3000;$/m
    # time on both clocks (a phone asleep stops one, a clock set back the other)
    assert @app =~
             ~r/^const clocks = \(\) => \(\{ p: performance\.now\(\), d: Date\.now\(\) \}\);$/m

    # shown again: no search of its own (the line clears itself if someone's
    # in sight — nearbyArrived, as while you watch)
    [vis] =
      Regex.run(
        ~r/document\.addEventListener\("visibilitychange", async \(\) => \{.*?\n\}\);/s,
        @app
      )

    refute vis =~ "findNearest", "the app shown again searches by itself"
    refute vis =~ "nearbyArrived", "the app shown again looks at the map by itself"
    [show] = Regex.run(~r/window\.addEventListener\("pageshow", \(e\) => \{.*?\n\}\);/s, @app)
    refute show =~ "findNearest"
    refute @app =~ ~s{addEventListener("pagehide"}
    refute @app =~ ~r/\bhiddenAt\b/, "the app still keeps a time away (nothing reads it)"

    # "nobody nearby yet": not looked at while the app is in the background
    lines_in_order(
      body("nearbyArrived"),
      [
        "if (!nobodyNear) return;",
        "if (!type || type !== nobodyType) return setNobodyNear(false);",
        "if (document.hidden) return;"
      ],
      "nearbyArrived"
    )
  end

  test "everyone it found gone a while (the map as it left it): looked again — 5 s, then longer, with jitter; outward from where it is; paused under a panel; only on its 1 s timer" do
    # the rule itself is HoodNearby.watchLook (pure; test_js/foundwatch.test.mjs
    # checks it look by look against the owner's rules, randomized); here, the
    # page's answers wired in — and the outcome acted on
    lines_in_order(
      body("stillSeen"),
      [
        "if (!foundWatch || nearLooking) return;",
        "const r = HoodNearby.watchLook(",
        "gapMs: NEAR_LOOK_GAP_MS,",
        "settledMs: NEAR_SETTLED_MS,",
        "stop: () => HoodNearby.lookingFor(state) !== foundWatch.type,",
        "hidden: () => document.hidden,",
        "covered: () => mapOutOfSight() || panelOpen(),",
        "refused: () => !DEMO && worldSync.refused(),",
        "ready: () => DEMO || (worldSync.settled() && serverRole === role && !renderMarkersSoon.pending()),",
        "message: () => !!bannerTimer,",
        "return peopleOnMap(foundWatch.type).some((p) => HoodNearby.inSight(map.project([p.pos.lng, p.pos.lat]), p.half || NEAR_HALF, size, covers));",
        "foundWatch = r.w;",
        "if (r.act === \"stop\") return stopFindNearest();",
        "findNearest(nearFrom(), { outFrom: map.getZoom() });",
        "researches = r.researches;"
      ],
      "stillSeen"
    )

    lines_in_order(
      body("watchFound"),
      [
        "foundWatch = { type, goneAt: null, seenAt: null, lookedAt: null, wait: HoodNearby.researchWait(researches, nearRand()) };",
        "clearInterval(foundCheck);",
        "foundCheck = setInterval(watchLook, 1000);"
      ],
      "watchFound"
    )

    lines_in_order(
      body("stopFindNearest"),
      [
        "nearSeq++;",
        "nearLooking = false;",
        "foundWatch = null;",
        "clearInterval(foundCheck);",
        "foundCheck = null;",
        "setNobodyNear(false);"
      ],
      "stopFindNearest"
    )

    assert @app =~ ~r/^let nearRand = \(\) => Math\.random\(\);$/m

    f = body("findNearest")

    lines_in_order(
      f,
      ["stopFindNearest();", "if (outFrom === null) researches = 0;"],
      "findNearest: a search of yours starts afresh"
    )

    assert f =~ ~r/^function findNearest\(at, \{ outFrom = null \} = \{\}\) \{$/m

    lines_in_order(
      f,
      [
        "const all = HoodNearby.zoomSteps(startZoom, widestZoom, NEAR_STEP);",
        "const steps = outFrom === null ? all : HoodNearby.stepsFrom(all, outFrom);"
      ],
      "findNearest: outward only"
    )

    lines_in_order(
      f,
      ["if (anyone(steps[i])) {", "nearLooking = false;", "return watchFound(type);"],
      "findNearest: found, watched"
    )

    # someone coming into sight under "nobody nearby yet": watched too
    lines_in_order(
      body("nearbyArrived"),
      [
        "if (!peopleOnMap(type).some(clear)) return;",
        "setNobodyNear(false);",
        "watchFound(type);"
      ],
      "nearbyArrived"
    )

    lines_in_order(
      body("panelOpen"),
      [
        ~s|return ["chat", "peer-card", "pile-sheet"].some((id) => { const el = document.getElementById(id); return !!el && !el.classList.contains("hidden"); });|
      ],
      "panelOpen"
    )

    # its own 1 s timer only — not on every marker redraw (a battery drain:
    # its wait is seconds); "nobody nearby yet" still is (it clears at once)
    for f <- ["renderRealMarkers", "refreshWorldMarkers"] do
      refute body(f) =~ "stillSeen", "#{f} looks at the found watch on every redraw"
      lines_in_order(body(f), ["nearbyArrived();"], f)
    end
  end

  test "a move of yours ends the search and its watch, and the back-off starts afresh" do
    lines_in_order(body("initMap"), ["if (!e.nearSearch) movedByHand();"], "initMap")
    lines_in_order(body("movedByHand"), ["researches = 0;", "stopFindNearest();"], "movedByHand")
  end

  test "anything thrown in a look — its first move too, or the watch's look — ends it cleanly: never left 'looking' for ever, never failing once a second" do
    lines_in_order(
      body("findNearest"),
      [
        "const check = () => {",
        "try {",
        "look();",
        "} catch (e) {",
        "if (seq === nearSeq) stopFindNearest();",
        "const look = () => {",
        "if (seq !== nearSeq) return;"
      ],
      "findNearest"
    )

    # the first move, too
    lines_in_order(
      body("findNearest"),
      [
        "nearLooking = true;",
        "try {",
        "camera(steps[0]);",
        "} catch (e) {",
        "stopFindNearest();",
        "return;"
      ],
      "findNearest: the first move"
    )

    refute body("findNearest") =~ ~r/^  camera\(steps\[0\]\);$/m,
           "the first move outside the catch"

    # the watch's look
    lines_in_order(
      body("watchFound"),
      ["foundCheck = setInterval(watchLook, 1000);"],
      "watchFound"
    )

    lines_in_order(
      body("watchLook"),
      ["try {", "stillSeen();", "} catch (e) {", "stopFindNearest();"],
      "watchLook"
    )
  end

  test "another device took over ('Use here'): any search here ends — nothing looks on behind the cover" do
    lines_in_order(
      body("onSessionMoved"),
      ["stopFindNearest();", "if (socket) socket.disconnect();"],
      "onSessionMoved"
    )
  end

  test "the map never turns or tilts (the search's maths is north-up and flat)" do
    i = body("initMap")
    assert i =~ "maxPitch: 0,"
    assert i =~ "dragRotate: false,"
    assert i =~ "pitchWithRotate: false,"
    assert i =~ "map.touchZoomRotate.disableRotation();"
  end

  # the banner is updated often (every tick, every message) — a forced
  # layout there lays out the WHOLE page at once: with a big chat open each
  # update took seconds and a reload missed its time (lightreload2,
  # 2026-11-10). Safari's stale balancing is undone without one: balancing
  # off, back on two frames later
  test "setBanner never forces a layout; it restores balancing two frames later" do
    b = body("setBanner")
    # (its comments name what's forbidden: the code is checked, not them)
    code = Regex.replace(~r{//[^
]*}, b, "")

    refute code =~
             ~r/offset(Width|Height|Top|Left)|getBoundingClientRect|getComputedStyle|scrollHeight|clientWidth/

    assert b =~ ~s[b.style.textWrap = "wrap";]
    assert b =~ "requestAnimationFrame(() =>
        requestAnimationFrame(() => {"
    assert b =~ ~s[if (b.dataset.text === text) b.style.textWrap = "";]
  end
end
