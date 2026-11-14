defmodule Hoodride.LimitsTest do
  @moduledoc """
  Every limit in one place: lib/hoodride/limits.ex (owner, 2026-11-12). This
  keeps it so — a limit-like number defined anywhere else in lib/ fails
  here, and so do the app's own copies (priv/static) when they drift.
  """
  use ExUnit.Case, async: true

  alias Hoodride.Limits

  # numbers in lib/ that limit nobody: internal tuning and units, each why
  @internal %{
    "id_min" => "account ids start above 2^32 (Accounts: never a guessable small id)",
    "id_span" => "…up to JavaScript's largest exact integer",
    "page" => "rows read per step when walking a table (Hoodride.ETS)",
    "repair_fresh_s" => "the index repair skips rows written this recently (a write in flight)",
    "max_pause_ms" => "the map recount pauses the writers at most this long",
    "writer_wait" =>
      "the cleanup pass waits on a map writer at most this long (Hoodride.SweeperStallTest)",
    "pause_target_us" => "…aiming for this per pause",
    "ewma_keep" => "the recount's learned batch size (a moving average)",
    "ns_per_ms" => "a unit",
    "check_every" => "how often a ride looks for abandonment",
    "every_ms" => "how often the sweeper runs",
    "minute" => "a unit",
    "hour" => "a unit",
    "protocol" => "the map's message format version",
    "spot_res" => "the map's block size (an H3 resolution — the app's, Hoodride.H3Test)",
    "cell_res" => "the map's neighborhood size (likewise)"
  }

  defp lib_files, do: Path.wildcard("lib/**/*.ex") -- ["lib/hoodride/limits.ex"]

  test "no limit-like number is defined outside lib/hoodride/limits.ex" do
    stray =
      for file <- lib_files(),
          {line, n} <- file |> File.read!() |> String.split("\n") |> Enum.with_index(1),
          [_, name] <- [Regex.run(~r/^\s*@([a-z_]+)\s+[-(0-9]/, line)],
          not Map.has_key?(@internal, name),
          do: "#{file}:#{n} @#{name}"

    assert stray == [],
           "put these in Hoodride.Limits (or, if they limit nobody, in @internal with why): #{inspect(stray)}"
  end

  test "the rate budgets are set nowhere but limits.ex (an environment may only switch one off)" do
    for file <- Path.wildcard("config/*.exs"),
        name <- Limits.budget_names(),
        line <- File.read!(file) |> String.split("\n"),
        String.starts_with?(line, "config :hoodride, #{inspect(name)},") do
      assert String.trim(line) == "config :hoodride, #{inspect(name)}, nil", "#{file}: #{line}"
    end

    refute Application.get_env(:hoodride, :http_budget),
           "nothing in code reads budgets but budget/1"

    offenders =
      for file <- lib_files(),
          name <- Limits.budget_names(),
          File.read!(file) =~ "get_env(:hoodride, #{inspect(name)}",
          do: "#{file} reads #{name}"

    assert offenders == []
  end

  # (2026-11-12: a test saved a budget with get_env — "not set" read as nil
  # — and put nil back: every budget OFF for the tests after it, and a
  # budget test elsewhere failed). save_env/restore_env keep the three apart
  test "a test's save and restore keep 'not set', 'off' and a number apart" do
    key = :limits_test_budget_probe
    on_exit(fn -> Application.delete_env(:hoodride, key) end)

    for before <- [:not_set, nil, [per_minute: 1, burst: 1]] do
      if before == :not_set,
        do: Application.delete_env(:hoodride, key),
        else: Application.put_env(:hoodride, key, before)

      saved = Hoodride.TestHelpers.save_env([key])
      Application.put_env(:hoodride, key, per_minute: 99, burst: 99)
      Hoodride.TestHelpers.restore_env(saved)

      after_ = Application.fetch_env(:hoodride, key)
      expected = if before == :not_set, do: :error, else: {:ok, before}
      assert after_ == expected, "#{inspect(before)} came back as #{inspect(after_)}"
    end
  end

  test "budget/1: this file's numbers, unless the environment switches it off" do
    assert Limits.budget(:sign_in_failures) == nil, "off in tests (config/test.exs)"
    assert Limits.budget(:chat_budget) == [per_minute: 60, burst: 60]
    assert_raise KeyError, fn -> Limits.budget(:not_a_budget) end
  end

  test "every entry has a group, a name, a value and a reason; names unique" do
    names = for {_g, name, _v, _note} <- Limits.all(), do: name
    assert names == Enum.uniq(names)

    for {group, name, value, note} <- Limits.all() do
      assert is_atom(group) and is_atom(name)
      assert is_number(value) or Keyword.keyword?(value), "#{name}"
      assert String.length(note) > 10, "#{name}: say why"
      assert apply(Limits, name, []) == value
    end
  end

  # the app's own copies: JavaScript can't read this file, so a test does
  test "the app's message box stops at app_message_chars (chatlist.js)" do
    js = File.read!("priv/static/chatlist.js")
    assert js =~ "const MAX_CHARS = #{Limits.app_message_chars()};"

    assert Limits.app_message_chars() < Limits.message_chars(),
           "the server's is the looser backstop"
  end

  test "the app's error reports: the same caps (errors.js)" do
    js = File.read!("priv/static/errors.js")
    assert js =~ "const MAX_MESSAGE = #{Limits.error_report_chars()};"
    assert js =~ "const PER_MINUTE = #{Limits.app_error_reports_per_minute()};"
    assert js =~ "const PER_SESSION = #{Limits.app_error_reports_per_session()};"
  end

  test "the stacked-marks check matches message_stacked_marks" do
    src = File.read!("lib/hoodride_web/channels/user_channel.ex")
    assert src =~ "@stacked_marks ~r/\\p{M}{#{Limits.message_stacked_marks() + 1}}/u"
  end

  test "mix hoodride.limits prints them all" do
    out = ExUnit.CaptureIO.capture_io(fn -> Mix.Tasks.Hoodride.Limits.run([]) end)
    for {_g, name, _v, _n} <- Limits.all(), do: assert(out =~ Atom.to_string(name))
  end
end
