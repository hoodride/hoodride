defmodule HoodrideWeb.MinifiedStatic do
  @moduledoc """
  For the browser journeys (test/browser/journeys_test.exs): our own JS and
  CSS served MINIFIED — as a release serves them (Mix.Tasks.Hoodride.Minify)
  — and everything else by the app as usual. The page asks for
  `app.js?vsn=…`; the minified copy answers whatever the version.
  """
  @behaviour Plug
  import Plug.Conn

  alias Mix.Tasks.Hoodride.Minify

  @impl true
  def init(dir) do
    types =
      Map.merge(
        Map.new(Minify.files(), &{&1, "text/javascript"}),
        Map.new(Minify.css_files(), &{&1, "text/css"})
      )

    %{dir: dir, types: types}
  end

  @impl true
  def call(%Plug.Conn{method: method, path_info: [name]} = conn, %{dir: dir, types: types})
      when method in ["GET", "HEAD"] do
    case types do
      %{^name => type} ->
        conn
        |> put_resp_content_type(type)
        |> put_resp_header("x-minified", "1")
        |> send_file(200, Path.join(dir, name))
        |> halt()

      _ ->
        HoodrideWeb.Endpoint.call(conn, HoodrideWeb.Endpoint.init([]))
    end
  end

  def call(conn, _), do: HoodrideWeb.Endpoint.call(conn, HoodrideWeb.Endpoint.init([]))
end
