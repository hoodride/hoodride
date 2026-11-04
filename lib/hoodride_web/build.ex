defmodule HoodrideWeb.Build do
  @moduledoc """
  Which build of the app this server runs: a fingerprint of the app's own
  files (everything Plug.Static serves, plus the page and the service
  worker), fixed when the server starts.

  An app left open keeps running the code it loaded — a single-page app
  never navigates, so the browser never looks for a new version itself.
  The page is stamped with this build as it's served, the map channel's
  join reply says the current one, and the app compares the two
  (priv/static/update.js decides when to reload). Nobody bumps it: change
  any file and deploy, and it differs; restart with nothing changed, and it
  doesn't — no pointless reloads. The service worker's cache is named after
  it too (no hand-bumped "hoodride-vNN").

  The wire protocol number (WorldChannel @protocol) stays set by hand: "old
  apps can no longer talk to this server" is a judgement, not a diff.
  """

  @key {__MODULE__, :build}

  @doc "The build this server runs (computed once, then kept)."
  def current do
    case :persistent_term.get(@key, nil) do
      nil ->
        build = compute(dir(), files())
        :persistent_term.put(@key, build)
        build

      build ->
        build
    end
  end

  @doc "The files the fingerprint covers (names relative to priv/static)."
  def files, do: Enum.uniq(HoodrideWeb.static_paths() ++ ["index.html", "sw.js"])

  defp dir, do: Application.app_dir(:hoodride, "priv/static")

  @doc """
  The fingerprint of `files` in `dir`: their names AND contents, in a fixed
  order, each length-prefixed (so "ab"+"c" and "a"+"bc" differ). Names that
  aren't a regular file (static_paths also lists folders) are skipped.
  """
  # sobelow_skip ["Traversal.FileModule"]
  def compute(dir, files) do
    files
    |> Enum.sort()
    |> Enum.reduce(:crypto.hash_init(:sha256), fn name, acc ->
      path = Path.join(dir, name)

      if File.regular?(path) do
        body = File.read!(path)

        acc
        |> :crypto.hash_update(<<byte_size(name)::32, name::binary>>)
        |> :crypto.hash_update(<<byte_size(body)::64, body::binary>>)
      else
        acc
      end
    end)
    |> :crypto.hash_final()
    |> Base.encode16(case: :lower)
    |> binary_part(0, 12)
  end
end
