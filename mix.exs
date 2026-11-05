defmodule Hoodride.MixProject do
  use Mix.Project

  def project do
    [
      app: :hoodride,
      version: "0.1.0",
      elixir: "~> 1.17",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: Mix.env() == :prod,
      aliases: aliases(),
      deps: deps(),
      listeners: [Phoenix.CodeReloader]
    ]
  end

  # Configuration for the OTP application.
  #
  # Type `mix help compile.app` for more information.
  def application do
    [
      mod: {Hoodride.Application, []},
      extra_applications: [:logger, :runtime_tools]
    ]
  end

  def cli do
    [
      preferred_envs: [precommit: :test]
    ]
  end

  # Specifies which paths to compile per environment.
  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  # Specifies your project dependencies.
  #
  # Type `mix help deps` for examples and options.
  defp deps do
    [
      {:phoenix, "~> 1.8.16"},
      {:phoenix_ecto, "~> 4.5"},
      {:ecto_sql, "~> 3.13"},
      {:ecto_sqlite3, ">= 0.0.0"},
      {:telemetry_metrics, "~> 1.0"},
      {:telemetry_poller, "~> 1.0"},
      {:jason, "~> 1.2"},
      {:dns_cluster, "~> 0.2.0"},
      {:bandit, "~> 1.5"},
      {:req, "~> 0.5"},
      {:hammer, "~> 7.0"},
      # minifies our own JS at deploy (and for the browser journeys): the
      # Phoenix team's package; it downloads the esbuild program, checking
      # npm's signature and its SHA-512 (config :esbuild, Mix.Tasks.Hoodride.Minify)
      {:esbuild, "0.10.0", runtime: false},
      # gettext's own .po/.pot reader and writer (Apache-2.0, the elixir-gettext
      # project): the translations' standard files, read at build time
      # (Mix.Tasks.Hoodride.I18n) — not needed while the app runs
      {:expo, "~> 1.1", runtime: false},
      {:sobelow, "~> 0.13", only: [:dev, :test], runtime: false},
      {:dialyxir, "~> 1.4", only: [:dev, :test], runtime: false},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false},
      {:stream_data, "~> 1.1", only: [:dev, :test]}
    ]
  end

  # Aliases are shortcuts or tasks specific to the current project.
  # For example, to install project dependencies and perform other setup tasks, run:
  #
  #     $ mix setup
  #
  # See the documentation for `Mix` for more info on aliases.
  defp aliases do
    [
      setup: ["deps.get", "ecto.setup"],
      "ecto.setup": ["ecto.create", "ecto.migrate", "run priv/repo/seeds.exs"],
      "ecto.reset": ["ecto.drop", "ecto.setup"],
      test: ["ecto.create --quiet", "ecto.migrate --quiet", "test"],
      precommit: [
        "compile --warnings-as-errors",
        "deps.unlock --unused",
        "format",
        # every message in the translators' list (priv/gettext/default.pot)
        "hoodride.i18n.extract --check",
        # each language's catalog script up to date with its translations
        "hoodride.i18n.build --check",
        # security scan: fails on any finding not reviewed in place (a
        # `# sobelow_skip [...]` above the function — survives line shifts)
        "sobelow --config",
        # no secrets in anything git would publish (gitleaks; skipped, with a
        # note, where it isn't installed) — .gitleaks.toml lists the harmless
        "hoodride.secrets",
        "test",
        # client viewport logic (priv/static/viewport.js) against the pinned h3-js
        ~s(cmd node --test "test_js/*.test.mjs")
      ]
    ]
  end
end
