defmodule HoodrideWeb.StaticVersions do
  @moduledoc """
  Versioned addresses for the app's files: `app.js?vsn=<fingerprint>`.

  The standard cache busting (MDN "HTTP caching", web.dev "HTTP cache"):
  new contents get a new address, so a versioned file can be kept a year
  (`immutable` — Plug.Static's own answer to `?vsn=`) and an old copy is
  never used by mistake. The page and the service worker are served stamped
  with these addresses (PageController); anything unversioned is `no-cache`
  (Endpoint). Without it, Cloudflare turned a plain "public" into 4 hours
  and a new page could run old scripts (found on deploy day, 2026-10-28).

  A fingerprint is the file's contents only — unlike HoodrideWeb.Build, an
  unchanged file keeps its address across deploys, so phones keep their copy.
  """

  @key {__MODULE__, :versions}

  @doc "Every app file's fingerprint, fixed at start-up in prod (prepare/0)."
  def current, do: :persistent_term.get(@key, nil) || live(dir(), files())

  @doc "One file's current fingerprint, or nil if it isn't an app file."
  def of(name) do
    case :persistent_term.get(@key, nil) do
      nil -> if name in files(), do: live(dir(), [name])[name]
      versions -> versions[name]
    end
  end

  @doc """
  PROD (with PageController.prepare/1, at start-up): fix the fingerprints the
  stamped page and worker carry — the running server answers exactly those.
  """
  def prepare, do: :persistent_term.put(@key, compute(dir(), files()))

  @doc false
  def forget, do: :persistent_term.erase(@key)

  @doc "Fingerprints of the regular files among `names` in `dir`."
  # sobelow_skip ["Traversal.FileModule"]
  def compute(dir, names) do
    for name <- names,
        path = Path.join(dir, name),
        File.regular?(path),
        into: %{} do
      {name, fingerprint(path)}
    end
  end

  @doc """
  DEV and TEST (no prepare/0): the same fingerprints, each file read again
  only when its size or last-changed time differs from when it was last
  read. Every page request used to read every app file again (~2.7 MB of
  scripts alone): the sitemap tests' ~150 pages took over half a minute and,
  with the whole suite running, passed the 60 s limit (2026-11-07).
  """
  # sobelow_skip ["Traversal.FileModule"]
  def live(dir, names) do
    for name <- names,
        path = Path.join(dir, name),
        {:ok, %File.Stat{type: :regular, size: size, mtime: mtime}} <- [
          File.stat(path, time: :posix)
        ],
        into: %{} do
      seen = {size, mtime}

      case :persistent_term.get({__MODULE__, :file, path}, nil) do
        {^seen, v} ->
          {name, v}

        _ ->
          v = fingerprint(path)
          :persistent_term.put({__MODULE__, :file, path}, {seen, v})
          {name, v}
      end
    end
  end

  # sobelow_skip ["Traversal.FileModule"]
  defp fingerprint(path) do
    :crypto.hash(:sha256, File.read!(path)) |> Base.encode16(case: :lower) |> binary_part(0, 12)
  end

  @doc ~S"""
  `text` with every quoted app file name `"name"` (and `src="name"`,
  `href="name"`) turned into `"name?vsn=…"` — from the root too,
  `"/name"` (the not-found page: any address deep).
  """
  def stamp(text, versions \\ current()) do
    Regex.replace(~r/"(\/?)([^"?:\/]+\.[a-z]+)"/, text, fn whole, root, name ->
      case versions do
        %{^name => v} -> ~s("#{root}#{name}?vsn=#{v}")
        _ -> whole
      end
    end)
  end

  defp files, do: HoodrideWeb.static_paths()
  defp dir, do: Application.app_dir(:hoodride, "priv/static")
end
