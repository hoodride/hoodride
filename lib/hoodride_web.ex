defmodule HoodrideWeb do
  @moduledoc """
  The entrypoint for defining your web interface, such
  as controllers, components, channels, and so on.

  This can be used in your application as:

      use HoodrideWeb, :controller
      use HoodrideWeb, :html

  The definitions below will be executed for every controller,
  component, etc, so keep them short and clean, focused
  on imports, uses and aliases.

  Do NOT define functions inside the quoted expressions
  below. Instead, define additional modules and import
  those modules here.
  """

  # (index.html and sw.js are not here: PageController serves them stamped
  # with the build — HoodrideWeb.Build)
  def static_paths,
    # each language's catalog script (Hoodride.I18n)
    do:
      ~w(assets fonts images favicon.ico app.js styles.css manifest.json car.png car-avatar.png icon-180.png icon-192.png icon-512.png phoenix.min.js h3-js.umd.js i18n.js viewport.js sync.js sendfilter.js locator.js browse.js rehydrate.js update.js session.js ridepos.js reveal_queue.js mapframe.js msgcopy.js boot.js avatarretry.js distance.js modestore.js viewstore.js readstore.js car.js icons.js avatar.js hand.svg pin.svg compass.svg chat.svg hand-avatar.svg person.svg fluent-emoji.LICENSE.txt chatlist.js chatmerge.js chatscroll.js navlink.js googlerefresh.js maplibre-gl.js maplibre-gl.css maplibre-gl.LICENSE.txt github-invertocat-white.svg discord-symbol-white.svg h3-js.LICENSE.txt phoenix.LICENSE.txt privacy.css og.png langswitch.js nearby.js translate.svg material-symbols.LICENSE.txt) ++
        Enum.flat_map(Hoodride.I18n.known(), &List.wrap(Hoodride.I18n.script(&1)))

  def router do
    quote do
      use Phoenix.Router, helpers: false

      # Import common connection and controller functions to use in pipelines
      import Plug.Conn
      import Phoenix.Controller
    end
  end

  def channel do
    quote do
      # joins at debug, not info: prod logs info, and Erlang's logger DROPS
      # everything once 200 messages queue up (drop_mode_qlen) — a line per
      # join made a burst of thousands drown its own errors (capacity test)
      use Phoenix.Channel, log_join: :debug
    end
  end

  def controller do
    quote do
      use Phoenix.Controller, formats: [:html, :json]

      import Plug.Conn

      unquote(verified_routes())
    end
  end

  def verified_routes do
    quote do
      use Phoenix.VerifiedRoutes,
        endpoint: HoodrideWeb.Endpoint,
        router: HoodrideWeb.Router,
        statics: HoodrideWeb.static_paths()
    end
  end

  @doc """
  When used, dispatch to the appropriate controller/live_view/etc.
  """
  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
