defmodule Mix.Tasks.Hoodride.Secrets do
  @shortdoc "Scans every file git would commit for secrets (gitleaks)"
  @moduledoc """
  The secret scan in `mix precommit` (owner, 2026-11-03: open-source prep).

  Scans what git would publish — tracked files plus new ones not ignored,
  so a key in a file that was never `git add`ed is caught too — with
  [gitleaks](https://github.com/gitleaks/gitleaks). Any finding fails the
  check. A value that only LOOKS like a secret is listed in the repo's
  `.gitleaks.toml`, matched by its file and line, with why it's harmless.

  Without gitleaks installed it says so and skips: anyone can still build
  Hood Ride; installing it (`winget install Gitleaks.Gitleaks`,
  `brew install gitleaks`) turns the check on.
  """
  use Mix.Task

  @impl true
  def run(_args) do
    case executable() do
      nil ->
        Mix.shell().info("""
        gitleaks: not installed — secret scan SKIPPED.
          Install it to turn the check on: https://github.com/gitleaks/gitleaks\
        """)

      exe ->
        root = repo_root()

        case scan_files(exe, root, publishable_files(root)) do
          {:ok, count} ->
            Mix.shell().info("gitleaks: no secrets in #{count} files")

          {:leaks, report} ->
            Mix.raise("""
            gitleaks found something that looks like a secret:

            #{report}
            Remove it, or — only if it's harmless — list it in .gitleaks.toml
            with why.
            """)
        end
    end
  end

  @doc "gitleaks on PATH, or where winget puts it on Windows (a shell opened before installing doesn't see it)."
  def executable do
    System.find_executable("gitleaks") ||
      case System.get_env("LOCALAPPDATA") do
        nil ->
          nil

        local ->
          # forward slashes: in a wildcard, "\" escapes the next character
          local
          |> String.replace("\\", "/")
          |> Path.join("Microsoft/WinGet/Packages/Gitleaks.Gitleaks*/gitleaks.exe")
          |> Path.wildcard()
          |> List.first()
      end
  end

  @doc "Scans `files` (relative to `root`) as a copy, so nothing outside them is read. `{:ok, count}` or `{:leaks, report}`."
  def scan_files(exe, root, files) do
    tmp = Path.join(System.tmp_dir!(), "hoodride-secrets-#{System.unique_integer([:positive])}")

    try do
      for f <- files do
        dest = Path.join(tmp, f)
        File.mkdir_p!(Path.dirname(dest))
        File.cp!(Path.join(root, f), dest)
      end

      # --redact: a finding never prints the secret itself
      config =
        if File.regular?(Path.join(tmp, ".gitleaks.toml")),
          do: ~w(--config .gitleaks.toml),
          else: []

      {out, status} =
        System.cmd(exe, ~w(dir . --redact --no-banner --no-color --exit-code 1 -v) ++ config,
          cd: tmp,
          stderr_to_stdout: true
        )

      if status == 0, do: {:ok, length(files)}, else: {:leaks, out}
    after
      File.rm_rf!(tmp)
    end
  end

  defp repo_root do
    {out, 0} = System.cmd("git", ~w(rev-parse --show-toplevel))
    String.trim(out)
  end

  # tracked + untracked-but-not-ignored, minus tracked files deleted on disk
  defp publishable_files(root) do
    {out, 0} = System.cmd("git", ~w(ls-files -z --cached --others --exclude-standard), cd: root)

    out
    |> String.split(<<0>>, trim: true)
    |> Enum.uniq()
    |> Enum.filter(&File.regular?(Path.join(root, &1)))
  end
end
