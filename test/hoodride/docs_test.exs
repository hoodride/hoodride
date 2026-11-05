defmodule Hoodride.DocsTest do
  @moduledoc """
  The guides for strangers stay true to the code (owner, 2026-11-03:
  open-source prep): every file and link they name exists, every setting
  the app reads is explained, and "Make it yours" lists every file where
  people see the Hood Ride name or hoodride.app.
  """
  use ExUnit.Case, async: true

  @docs ~w(README.md SELF_HOSTING.md GOOGLE_SETUP.md SECURITY.md THIRD-PARTY.md)

  defp doc(name), do: File.read!(name)

  test "links between the guides point to files that exist" do
    for d <- @docs,
        [_, target] <- Regex.scan(~r/\]\(([^)#\s]+)\)/, doc(d)),
        not String.starts_with?(target, ["http://", "https://", "mailto:", "../"]) do
      assert File.exists?(target), "#{d} links to #{target}, which doesn't exist"
    end
  end

  # a phone picture shown phone-sized (300 px, centered — the usual README
  # way: an <img> with a width), drawn at twice that so it stays sharp
  # (owner, 2026-11-03: it filled more than a screen)
  test "the README's picture: shown 300 px wide, drawn 600 px wide" do
    readme = doc("README.md")

    assert readme =~
             ~s(<p align="center"><img src="docs/screenshot.png" width="300" alt="Hood Ride's demo: cars on a map"></p>)

    for [_, src] <- Regex.scan(~r/<img src="([^"]+)"/, readme), do: assert(File.exists?(src), src)

    <<_::binary-size(16), width::32, _height::32, _::binary>> = File.read!("docs/screenshot.png")
    assert width == 600
  end

  test "every file path the guides name exists" do
    for d <- @docs,
        [_, path] <-
          Regex.scan(
            ~r{`((?:priv|lib|deploy|config|assets|brand|rel|test|test_js|test_browser|docs)/[\w./-]+)`},
            doc(d)
          ),
        not String.contains?(path, "YOUR-") do
      assert File.exists?(path), "#{d} names #{path}, which doesn't exist"
    end
  end

  test "the commands the README gives exist" do
    aliases = Mix.Project.config()[:aliases]
    readme = doc("README.md")

    for cmd <- ~w(setup precommit),
        do: assert(readme =~ "mix #{cmd}" and Keyword.has_key?(aliases, String.to_atom(cmd)))

    assert readme =~ "git clone https://github.com/hoodride/hoodride.git\n   cd hoodride\n"
  end

  # the community (owner, 2026-11-04): the Discord invite (set to never
  # expire), Discussions and Issues
  test "the README says where to talk" do
    readme = doc("README.md")
    assert readme =~ "**[Discord](https://discord.gg/ehce7eGQFt)**"
    assert readme =~ "[Discussions](../../discussions)"
    assert readme =~ "[Issues](../../issues)"
  end

  # a setting the app reads at start must be explained where a person
  # running their own copy looks: the settings file's example, the service,
  # or the guides
  test "every setting the app reads is explained somewhere" do
    # (not the commented-out examples Phoenix ships)
    runtime =
      File.read!("config/runtime.exs")
      |> String.split("
")
      |> Enum.reject(&String.match?(&1, ~r/^\s*#/))
      |> Enum.join("
")

    vars =
      Regex.scan(~r/System\.get_env\("([A-Z_]+)"/, runtime)
      |> Enum.map(&List.last/1)
      |> Enum.uniq()

    assert "PHX_HOST" in vars and "GOOGLE_CLIENT_ID" in vars

    explained =
      Enum.map_join(
        # (PHX_SERVER: the release's own start script sets it)
        ~w(deploy/env.example deploy/hoodride.service rel/overlays/bin/server SELF_HOSTING.md),
        "\n",
        &File.read!/1
      )

    for v <- vars,
        do: assert(explained =~ v, "#{v} is read in config/runtime.exs but explained nowhere")

    # the ones the app refuses to start without: set by the service or the example
    setup = File.read!("deploy/env.example") <> File.read!("deploy/hoodride.service")

    for [_, v] <- Regex.scan(~r/System\.get_env\("([A-Z_]+)"\)\s*\|\|\s*raise/, runtime),
        do:
          assert(
            setup =~ "#{v}=",
            "#{v} is required but neither env.example nor the service sets it"
          )
  end

  # what a person sees, not comments
  defp visible(path, text) do
    cond do
      String.ends_with?(path, ".html") ->
        Regex.replace(~r/<!--.*?-->/s, text, "")

      String.ends_with?(path, ".js") ->
        Regex.replace(~r{/\*.*?\*/}s, text, "")
        |> String.split("\n")
        |> Enum.reject(&String.match?(&1, ~r{^\s*//}))
        |> Enum.map_join("\n", &Regex.replace(~r{\s//\s.*$}, &1, ""))

      String.ends_with?(path, [".ex", ".txt"]) ->
        Regex.replace(~r/@(moduledoc|doc|shortdoc)\s+"""(.*?)"""/s, text, "")
        |> String.split("\n")
        |> Enum.reject(&String.match?(&1, ~r/^\s*#/))
        |> Enum.map_join("\n", &Regex.replace(~r/\s#\s.*$/, &1, ""))

      true ->
        text
    end
  end

  test "'Make it yours' lists every file that shows the Hood Ride name or hoodride.app" do
    [_, yours] = String.split(doc("SELF_HOSTING.md"), "## Make it yours", parts: 2)
    [yours | _] = String.split(yours, "\n## ", parts: 2)

    showing =
      for f <- Path.wildcard("priv/static/*.{html,json,js,txt}") ++ Path.wildcard("lib/**/*.ex"),
          visible(f, File.read!(f)) =~ ~r/Hood Ride|hoodride\.app/,
          do: f

    # the checker itself sees the name where it should
    assert "priv/static/index.html" in showing and "priv/static/terms.html" in showing

    for f <- showing,
        do: assert(yours =~ "`#{f}`", "#{f} shows the name but 'Make it yours' doesn't list it")
  end

  # the load and stress scripts live in test_load/, beside test_js/ and
  # test_browser/ — not loose at the top of the repository (owner,
  # 2026-11-04); each loads the app's own code from ../priv/static
  test "the load scripts: in test_load/, and what they load exists" do
    {top, 0} = System.cmd("git", ~w(ls-files))
    loose = top |> String.split("\n", trim: true) |> Enum.filter(&(&1 =~ ~r{^[^/]+\.mjs$}))
    assert loose == [], "scripts loose at the top: #{inspect(loose)}"

    scripts = Path.wildcard("test_load/*.mjs")
    assert length(scripts) >= 9

    for s <- scripts,
        [_, path] <- Regex.scan(~r/require\("([^"]+)"\)/, File.read!(s)) do
      assert String.starts_with?(path, "../priv/static/"), "#{s} loads #{path}"

      assert File.exists?(Path.expand(path, "test_load")),
             "#{s} loads #{path}, which doesn't exist"
    end

    # their own "Run:" lines say where they are now
    for s <- scripts, do: refute(File.read!(s) =~ "e2e_", s)
  end

  # a script someone runs (`deploy/install_beam.sh`, the service's
  # `bin/server`) must be executable in git itself: on a Linux clone from
  # GitHub, git's mode is all there is. Packing on Windows had hidden it —
  # all six were stored 644, "Permission denied" at SELF_HOSTING step 3
  # (found 2026-11-04). Templates (.eex) are read, not run.
  test "every script is stored executable" do
    {out, 0} = System.cmd("git", ~w(ls-files -s))

    scripts =
      for line <- String.split(out, "\n", trim: true),
          [mode, _hash, _stage, path] = String.split(line, ~r/\s+/, parts: 4),
          not String.ends_with?(path, ".eex"),
          File.regular?(path),
          match?("#!" <> _, File.read!(path)),
          do: {path, mode}

    assert {"deploy/install_beam.sh", "100755"} in scripts
    assert {"rel/overlays/bin/server", "100755"} in scripts

    for {path, mode} <- scripts,
        do: assert(mode == "100755", "#{path} is stored #{mode}: not executable on a Linux clone")
  end

  # a NUL character in a text file makes git treat it as binary (no diffs,
  # no review); shell quoting once wrote one into a test file instead of
  # the text "\u0000" (2026-11-04). Any other control character is as
  # unseen: a Python string turned the regex `\b` (a word's edge) into a
  # backspace — twice, once in a test that then checked nothing (2026-11-04)
  test "no text file holds a NUL or other hidden control character" do
    {out, 0} = System.cmd("git", ~w(ls-files --cached --others --exclude-standard))
    text = ~w(.ex .exs .eex .js .mjs .css .html .md .json .txt .sh .toml .yml .service .conf .svg)

    files =
      out
      |> String.split("\n", trim: true)
      |> Enum.filter(&(Path.extname(&1) in text and File.regular?(&1)))

    assert length(files) > 300

    for f <- files do
      # (tab, line feed and carriage return are text)
      refute File.read!(f) =~ ~r/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/,
             "#{f} holds a hidden control character"
    end
  end

  test "the server guide says what hoodride.app actually runs on" do
    guide = doc("SELF_HOSTING.md")
    assert guide =~ "Ubuntu 24.04"
    assert File.read!("deploy/setup.sh") =~ "Ubuntu 24.04"
    # the tunnel steps match the tunnel file
    assert File.read!("deploy/cloudflared-config.yml") =~ "SELF_HOSTING.md, step 6"
    assert guide =~ "6. **The tunnel**"
  end
end
