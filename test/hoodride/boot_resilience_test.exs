defmodule Hoodride.BootResilienceTest do
  @moduledoc """
  Crash review 2026-11-13: two TIDYING steps at start-up could stop the
  whole app from starting — the profile-photo folder (created, then old
  photos swept) and the expired sign-ins (deleted before the valid ones
  are loaded: a full disk refuses the delete). Tidying that fails is
  logged and skipped; the app starts. (Loading the valid sign-ins is not
  tidying: that one failing still stops the start, on purpose.)
  """
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    :ok
  end

  test "the photo folder can't be made: logged, the start goes on" do
    blocker = Path.join(System.tmp_dir!(), "hr-boot-#{System.unique_integer([:positive])}")
    File.write!(blocker, "a file where a folder's parent should be")
    old = Application.fetch_env!(:hoodride, :avatar_dir)
    Application.put_env(:hoodride, :avatar_dir, Path.join(blocker, "avatars"))

    try do
      log = capture_log(fn -> assert Hoodride.Avatars.start_link() == :ignore end)
      assert log =~ "profile photos"
    after
      Application.put_env(:hoodride, :avatar_dir, old)
      File.rm(blocker)
    end
  end

  test "expired sign-ins can't be deleted (a full disk): logged, the valid ones still load" do
    Application.put_env(:hoodride, :token_prune, fn _now ->
      raise Exqlite.Error, message: "database or disk is full"
    end)

    try do
      log = capture_log(fn -> assert Hoodride.SessionTokens.load() == :ok end)
      assert log =~ "expired sign-ins"
    after
      Application.delete_env(:hoodride, :token_prune)
    end
  end
end
