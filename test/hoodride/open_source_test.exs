defmodule Hoodride.OpenSourceTest do
  @moduledoc """
  Open-source prep (owner, 2026-11-03): MIT for Hood Ride, every bundled
  file's own license beside it, a private way to report security problems,
  and a secret scan before every commit.
  """
  use ExUnit.Case, async: true

  alias Mix.Tasks.Hoodride.Secrets

  @root "."
  @static "priv/static"

  defp root(file), do: File.read!(Path.join(@root, file))

  test "Hood Ride is MIT, in the name 'Hood Ride'" do
    license = root("LICENSE")
    assert license =~ ~r/\AMIT License\n\nCopyright \(c\) 2026 Hood Ride\n/
    assert license =~ "Permission is hereby granted, free of charge"
    assert license =~ ~s(THE SOFTWARE IS PROVIDED "AS IS")
  end

  test "every bundled file ships with its license, served beside it" do
    for {file, license, must} <- [
          {"maplibre-gl.js", "maplibre-gl.LICENSE.txt", "MapLibre contributors"},
          {"h3-js.umd.js", "h3-js.LICENSE.txt",
           "Apache License\n                           Version 2.0, January 2004"},
          {"phoenix.min.js", "phoenix.LICENSE.txt", "Copyright (c) 2014 Chris McCord"},
          {"icons.js", "fluent-emoji.LICENSE.txt", "Copyright (c) Microsoft Corporation."},
          {"translate.svg", "material-symbols.LICENSE.txt", "Apache License"}
        ] do
      assert File.read!(Path.join(@static, license)) =~ must, license
      assert file in HoodrideWeb.static_paths() and license in HoodrideWeb.static_paths(), license
      assert root("THIRD-PARTY.md") =~ "`#{license}`", license
    end

    # the Apache text exactly as apache.org publishes it
    apache = File.read!(Path.join(@static, "h3-js.LICENSE.txt"))

    assert :crypto.hash(:md5, apache) |> Base.encode16(case: :lower) ==
             "3b83ef96387f14655fc854ddc3c6bd57"
  end

  test "the name and logo aren't part of the MIT license" do
    assert root("THIRD-PARTY.md") =~
             ~s("Hood Ride", its name and logo, are not covered by the MIT license)
  end

  test "security problems: reported privately, answered within 14 days" do
    security = root("SECURITY.md")
    assert security =~ "contact@hoodride.app"
    assert security =~ "**don't** open a public issue"
    # a goal, not a guarantee (owner, 2026-11-04): one person answers
    assert security =~ "We aim to reply within **14 days**"
    assert security =~ "never\nagainst hoodride.app or its users"
  end

  test "precommit scans for secrets" do
    assert "hoodride.secrets" in Mix.Project.config()[:aliases][:precommit]
  end

  describe "the secret scan" do
    @describetag :tmp_dir
    # (where gitleaks isn't installed these pass without running: the scan
    # itself skips there too)
    setup do
      {:ok, exe: Secrets.executable()}
    end

    # a key-shaped value built here, never written in this file (the scan
    # reads this file too)
    defp fake_github_token do
      alphabet = ~c"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
      "ghp_" <> for(_ <- 1..36, into: "", do: <<Enum.random(alphabet)>>)
    end

    test "catches a key, and never prints it", %{tmp_dir: dir} = ctx do
      if exe = ctx[:exe] do
        token = fake_github_token()
        File.write!(Path.join(dir, "config.exs"), ~s(config :x, token: "#{token}"\n))
        assert {:leaks, report} = Secrets.scan_files(exe, dir, ["config.exs"])
        assert report =~ "config.exs"
        refute report =~ token
      end
    end

    test "a clean file passes", %{tmp_dir: dir} = ctx do
      if exe = ctx[:exe] do
        File.write!(Path.join(dir, "ok.exs"), ~s(config :x, name: "Hood Ride"\n))
        assert {:ok, 1} = Secrets.scan_files(exe, dir, ["ok.exs"])
      end
    end

    # the harmless look-alikes are matched by file AND line: the same kind of
    # value anywhere else is still caught
    # a Phoenix key, whatever it starts with: gitleaks' general rule missed
    # one starting with "+" or "/" (about 1 in 32 — this test failed now and
    # then, 2026-11-04); our own rule (.gitleaks.toml) catches every one
    test "a secret_key_base is caught whatever it starts with", %{tmp_dir: dir} = ctx do
      if exe = ctx[:exe] do
        File.cp!(Path.join(@root, ".gitleaks.toml"), Path.join(dir, ".gitleaks.toml"))
        File.mkdir_p!(Path.join(dir, "config"))
        body = Base.encode64(:crypto.strong_rand_bytes(48))

        for first <- ["/", "+", "a", "Z", "7"] do
          key = first <> binary_part(body, 1, byte_size(body) - 1)

          File.write!(
            Path.join(dir, "config/prod.exs"),
            ~s(config :x,\n  secret_key_base: "#{key}"\n)
          )

          assert {:leaks, report} =
                   Secrets.scan_files(exe, dir, [".gitleaks.toml", "config/prod.exs"]),
                 first

          refute report =~ key
        end
      end
    end

    test "the allow list covers only its own files and lines", %{tmp_dir: dir} = ctx do
      if exe = ctx[:exe] do
        File.cp!(Path.join(@root, ".gitleaks.toml"), Path.join(dir, ".gitleaks.toml"))
        key = Base.encode64(:crypto.strong_rand_bytes(48))
        dev = "config/dev.exs"
        other = "config/prod.exs"

        for f <- [dev, other] do
          File.mkdir_p!(Path.join(dir, Path.dirname(f)))
          File.write!(Path.join(dir, f), ~s(config :x,\n  secret_key_base: "#{key}"\n))
        end

        assert {:ok, 2} = Secrets.scan_files(exe, dir, [".gitleaks.toml", dev])
        assert {:leaks, report} = Secrets.scan_files(exe, dir, [".gitleaks.toml", dev, other])
        assert report =~ "prod.exs"
        refute report =~ "dev.exs"
      end
    end
  end
end
