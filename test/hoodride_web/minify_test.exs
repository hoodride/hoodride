defmodule HoodrideWeb.MinifyTest do
  @moduledoc """
  Our own JS, minified at deploy (Mix.Tasks.Hoodride.Minify, `config
  :esbuild`; owner, 2026-10-30). The browser journeys run on the minified
  files (test/browser/journeys_test.exs); this checks the files themselves.
  """
  use ExUnit.Case, async: false

  alias Mix.Tasks.Hoodride.Minify

  @static "priv/static"

  setup_all do
    out =
      Path.join(System.tmp_dir!(), "hoodride_minify_test_#{System.unique_integer([:positive])}")

    File.mkdir_p!(out)
    on_exit(fn -> File.rm_rf!(out) end)
    status = Minify.minify(Enum.map(Minify.files(), &Path.join(@static, &1)), out)
    %{out: out, status: status}
  end

  test "every one of our files is minified; the minified libraries and sw.js are left alone",
       %{out: out, status: status} do
    assert status == 0
    assert "app.js" in Minify.files()
    for f <- ~w(maplibre-gl.js phoenix.min.js h3-js.umd.js sw.js), do: refute(f in Minify.files())
    # the languages' catalogs: generated, compact — never minified (it would
    # turn their letters into \u escapes)
    for f <- ~w(i18n-es.js i18n-ja.js i18n-en-XA.js), do: refute(f in Minify.files())
    assert "i18n.js" in Minify.files()
    for f <- Minify.files(), do: assert(File.exists?(Path.join(out, f)), f)
  end

  test "much smaller: under 60% of the readable files", %{out: out} do
    size = fn dir ->
      Minify.files() |> Enum.map(&File.stat!(Path.join(dir, &1)).size) |> Enum.sum()
    end

    assert size.(out) < 0.6 * size.(@static), "#{size.(out)} of #{size.(@static)} bytes"
  end

  # the files share globals (HoodSync, state, …) and the journeys call the
  # app's own functions: esbuild without bundling keeps top-level names
  test "every top-level name is kept", %{out: out} do
    for f <- Minify.files() do
      src = File.read!(Path.join(@static, f))
      min = File.read!(Path.join(out, f))

      names =
        Regex.scan(
          ~r/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/m,
          src,
          capture: :all_but_first
        )
        |> List.flatten()
        |> Enum.reject(&(&1 == ""))

      for name <- names,
          do: assert(min =~ ~r/(?<![\w$])#{Regex.escape(name)}(?![\w$])/, "#{f}: #{name} renamed")
    end
  end

  # the maps hand out the readable code: beside the files, never linked
  test "source maps are written but never linked from the files", %{out: out} do
    for f <- Minify.files() do
      assert File.exists?(Path.join(out, f <> ".map")), "#{f}.map"
      refute File.read!(Path.join(out, f)) =~ "sourceMappingURL", f
    end
  end

  test "and never served: no .map among the files the server serves" do
    refute Enum.any?(HoodrideWeb.static_paths(), &String.ends_with?(&1, ".map"))
  end

  # without --keep every deploy downloads the program again (below)
  test "deploy.sh minifies with the esbuild program kept in ~/.cache/hoodride" do
    deploy = File.read!("deploy/deploy.sh")

    assert deploy =~
             ~r/^mix hoodride\.minify --in-place "\$STATIC" --keep "\$HOME\/\.cache\/hoodride"$/m
  end

  # the esbuild program (owner, 2026-10-31): a deploy builds from a fresh
  # folder, so `--keep DIR` holds the program between deploys — restored
  # only when it's the configured version (a version bump downloads the new
  # one), and minifying with any other version stops instead of warning
  describe "the esbuild program" do
    setup do
      dir =
        Path.join(System.tmp_dir!(), "hoodride_minify_keep_#{System.unique_integer([:positive])}")

      File.mkdir_p!(dir)
      real = Esbuild.bin_path()
      assert File.exists?(real), "esbuild installed here (mix esbuild.install)"
      old_path = Application.get_env(:esbuild, :path)
      old_version = Application.get_env(:esbuild, :version)

      on_exit(fn ->
        restore_env(:path, old_path)
        restore_env(:version, old_version)
        File.rm_rf!(dir)
      end)

      # as on a fresh deploy folder: the program not there yet
      target = Path.join([dir, "build", Path.basename(real)])
      Application.put_env(:esbuild, :path, target)
      keep = Path.join(dir, "keep")
      %{real: real, target: target, keep: keep, kept: Path.join(keep, Path.basename(real))}
    end

    defp restore_env(key, nil), do: Application.delete_env(:esbuild, key)
    defp restore_env(key, value), do: Application.put_env(:esbuild, key, value)

    defp put_kept(kept, from) do
      File.mkdir_p!(Path.dirname(kept))
      File.cp!(from, kept)
      File.chmod!(kept, 0o755)
    end

    test "the kept program of the configured version is put back (no download)", c do
      put_kept(c.kept, c.real)
      assert Minify.restore_kept(c.keep) == :restored
      assert File.read!(c.target) == File.read!(c.real)
      assert Esbuild.bin_version() == {:ok, Esbuild.configured_version()}
    end

    test "a kept program of another version is NOT put back: the new one downloads", c do
      put_kept(c.kept, c.real)
      Application.put_env(:esbuild, :version, "0.0.1")
      assert Minify.restore_kept(c.keep) == :not_kept
      refute File.exists?(c.target)
    end

    test "something that isn't a working program is not put back", c do
      File.mkdir_p!(c.keep)
      File.write!(c.kept, "not esbuild")
      assert Minify.restore_kept(c.keep) == :not_kept
      refute File.exists?(c.target)
    end

    test "nothing kept yet: nothing put back", c do
      assert Minify.restore_kept(c.keep) == :not_kept
      refute File.exists?(c.target)
    end

    test "a program already in place is left alone", c do
      put_kept(c.kept, c.real)
      File.mkdir_p!(Path.dirname(c.target))
      File.write!(c.target, "already here")
      assert Minify.restore_kept(c.keep) == :not_kept
      assert File.read!(c.target) == "already here"
    end

    test "a deploy with the program kept: minified, nothing downloaded", c do
      put_kept(c.kept, c.real)
      Application.put_env(:hoodride, :esbuild_install, fn -> flunk("downloaded") end)
      on_exit(fn -> Application.delete_env(:hoodride, :esbuild_install) end)
      out = Path.join(Path.dirname(c.keep), "out")
      assert Minify.minify([Path.join(@static, "readstore.js")], out, [], c.keep) == 0
      assert File.exists?(Path.join(out, "readstore.js"))
    end

    test "nothing kept (or another version): the program is downloaded", c do
      me = self()

      Application.put_env(:hoodride, :esbuild_install, fn ->
        send(me, :downloaded)
        put_kept(c.target, c.real)
      end)

      on_exit(fn -> Application.delete_env(:hoodride, :esbuild_install) end)
      out = Path.join(Path.dirname(c.keep), "out")
      assert Minify.minify([Path.join(@static, "readstore.js")], out, [], c.keep) == 0
      assert_received :downloaded
      assert File.read!(c.kept) == File.read!(c.real), "and kept for next time"
    end

    test "after minifying, the program used is kept for the next deploy", c do
      put_kept(c.target, c.real)
      out = Path.join(Path.dirname(c.keep), "out")
      app = Path.join(@static, "readstore.js")
      assert Minify.minify([app], out, [], c.keep) == 0
      assert File.read!(c.kept) == File.read!(c.real)
    end

    test "minifying with another version than configured stops the build", c do
      put_kept(c.target, c.real)
      Application.put_env(:esbuild, :version, "0.0.1")
      out = Path.join(Path.dirname(c.keep), "out")

      assert_raise Mix.Error, ~r/esbuild #{Regex.escape(Esbuild.configured_version())}/, fn ->
        Minify.minify([Path.join(@static, "readstore.js")], out, [], c.keep)
      end

      refute File.exists?(Path.join(out, "readstore.js"))
      refute File.exists?(c.kept), "the wrong one isn't kept"
    end
  end

  # the browsers in `config :esbuild` are the floor: syntax the oldest can't
  # run (BigInt `1n`: Safari 14) fails the build instead of reaching phones
  test "syntax older phones can't run fails the build" do
    dir =
      Path.join(System.tmp_dir!(), "hoodride_minify_guard_#{System.unique_integer([:positive])}")

    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    bad = Path.join(dir, "bad.js")
    File.write!(bad, "var big = 1n;\n")
    assert Minify.minify([bad], Path.join(dir, "out")) != 0
  end
end
