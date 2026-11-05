defmodule Mix.Tasks.Hoodride.Minify do
  @shortdoc "Minifies our own JS: into a folder, or a release's files in place"

  @moduledoc """
  Our own JS, minified with esbuild (owner, 2026-10-30; the settings and
  why: `config :esbuild`). The repo keeps the readable files — only a
  release (at deploy) or a test folder gets the minified ones.

      mix hoodride.minify --in-place RELEASE/lib/hoodride-X/priv/static
      mix hoodride.minify --out DIR        # from priv/static
      … --keep DIR                        # the esbuild program, between deploys

  Left alone: the libraries that come minified, and sw.js (the page
  controller rewrites its cache name when serving it).

  The esbuild program (owner, 2026-10-31): only ever the configured
  version — any other stops the build (the esbuild package only warns, and
  downloads only when the program is missing, never when it's outdated).
  A deploy builds from a fresh folder, so `--keep` holds the program
  between deploys: put back only when it's the configured version (after a
  version bump the new one downloads — npm's signature and SHA-512
  checked — and is kept instead).
  """
  use Mix.Task

  @skip ~w(maplibre-gl.js phoenix.min.js h3-js.umd.js sw.js)

  @doc "The files minified: our own JS that's served."
  # (and not the languages' catalogs, i18n-<lang>.js: generated, already
  # compact data — minifying would only turn their letters into \u escapes,
  # several times bigger; languages, 2026-11-04)
  def files do
    HoodrideWeb.static_paths()
    |> Enum.filter(&String.ends_with?(&1, ".js"))
    |> Enum.reject(&(&1 in @skip or &1 =~ ~r/^i18n-.+\.js$/))
  end

  # No developer notes in what the public gets (owner, 2026-11-02): our own
  # CSS minified by esbuild too (ordinary comments go; it keeps only
  # /*! … */ and @license ones — we have none), and the comments taken out
  # of the pages the server sends (PageController reads them from the same
  # folder). maplibre-gl.css is the library's own, left alone.
  @css ~w(styles.css privacy.css)
  @pages ~w(index.html privacy.html terms.html notfound.html)

  @doc "Our own stylesheets, minified with the JS."
  def css_files, do: @css

  @doc "The pages the server sends (PageController): their comments are taken out."
  def pages, do: @pages

  @doc """
  The whole build: our JS and CSS minified from `from` into `out`, and the
  pages copied there without their comments. → esbuild's exit status
  """
  def build(from, out, extra \\ [], keep \\ nil) do
    entries = Enum.map(files() ++ css_files(), &Path.join(from, &1))
    status = minify(entries, out, extra, keep)

    if status == 0 do
      for page <- @pages do
        html = File.read!(Path.join(from, page))
        File.write!(Path.join(out, page), strip_html_comments(html))
      end
    end

    status
  end

  @doc """
  `html` without its `<!-- … -->` comments; a comment alone on its line(s)
  takes the line with it. Safe only because the pages hold no inline
  script, style, textarea or pre (HoodrideWeb.NoCommentsTest checks), and
  never reaching past a comment's own end — markup after it stays.
  """
  def strip_html_comments(html) do
    html
    |> then(&Regex.replace(~r/^[ \t]*<!--(?:(?!-->).)*-->[ \t]*\r?\n/ms, &1, ""))
    |> then(&Regex.replace(~r/<!--(?:(?!-->).)*-->/s, &1, ""))
  end

  @doc """
  Minify `entries` (paths) into `out`; `extra` esbuild flags; `keep` a
  folder holding the program between deploys (or nil). → exit status
  """
  def minify(entries, out, extra \\ [], keep \\ nil) do
    # (a build-time dependency: not started with the app)
    {:ok, _} = Application.ensure_all_started(:esbuild)
    if keep, do: restore_kept(keep)
    # (the download; a test swaps it to see whether it would happen)
    install = Application.get_env(:hoodride, :esbuild_install, &Esbuild.install/0)
    File.exists?(Esbuild.bin_path()) || install.()

    case {Esbuild.bin_version(), Esbuild.configured_version()} do
      {{:ok, same}, same} ->
        :ok

      {found, wanted} ->
        Mix.raise(
          "esbuild #{wanted} expected (config :esbuild), found #{inspect(found)} at " <>
            "#{Esbuild.bin_path()} — run `mix esbuild.install`"
        )
    end

    # (the configured version, checked just above: kept for the next deploy)
    if keep, do: save_kept(keep)
    Esbuild.run(:minify, entries ++ ["--outdir=#{out}" | extra])
  end

  @doc "Put the kept program in place if it's missing there and the configured version. → :restored | :not_kept"
  def restore_kept(keep) do
    bin = Esbuild.bin_path()
    kept = Path.join(keep, Path.basename(bin))

    if not File.exists?(bin) and version_of(kept) == {:ok, Esbuild.configured_version()} do
      File.mkdir_p!(Path.dirname(bin))
      File.cp!(kept, bin)
      File.chmod!(bin, 0o755)
      :restored
    else
      :not_kept
    end
  end

  defp save_kept(keep) do
    bin = Esbuild.bin_path()
    kept = Path.join(keep, Path.basename(bin))
    File.mkdir_p!(keep)
    File.cp!(bin, kept)
    File.chmod!(kept, 0o755)
  end

  defp version_of(path) do
    with true <- File.exists?(path),
         {out, 0} <- System.cmd(path, ["--version"], stderr_to_stdout: true) do
      {:ok, String.trim(out)}
    else
      _ -> :error
    end
  rescue
    # not a program this system can run
    _ in ErlangError -> :error
  end

  @impl true
  def run(args) do
    {opts, _} =
      OptionParser.parse!(args, strict: [in_place: :string, out: :string, keep: :string])

    {keep, opts} = Keyword.pop(opts, :keep)
    Mix.Task.run("compile")

    {from, out, extra} =
      case opts do
        [in_place: dir] -> {dir, dir, ["--allow-overwrite"]}
        [out: dir] -> {Path.join(File.cwd!(), "priv/static"), dir, []}
        _ -> Mix.raise("usage: mix hoodride.minify --in-place DIR | --out DIR")
      end

    status = build(from, out, extra, keep)
    if status != 0, do: Mix.raise("esbuild failed (#{status})")

    Mix.shell().info(
      "minified #{length(files()) + length(css_files())} files and took the comments " <>
        "out of #{length(pages())} pages, into #{out}"
    )
  end
end
