defmodule HoodrideWeb.DeviceGateTest do
  @moduledoc """
  Phones and tablets only (owner, 2026-11-14): the app decides in the page
  (HoodDevice, Bowser + the iPad and desktop-mode tablet checks); the
  server only says when ANY device may open it — development and the
  tests' browsers, which are desktops — never in production.
  """
  use HoodrideWeb.ConnCase, async: false

  setup do
    on_exit(fn -> Application.put_env(:hoodride, :any_device, true) end)
    :ok
  end

  test "development and the tests: any device (the page says so)", %{conn: conn} do
    Application.put_env(:hoodride, :any_device, true)
    assert html_response(get(conn, "/"), 200) =~ ~s(<meta name="hoodride-any-device" content="1">)
  end

  test "otherwise (production): no such word — the page decides by the device", %{conn: conn} do
    Application.put_env(:hoodride, :any_device, false)
    refute html_response(get(conn, "/"), 200) =~ "hoodride-any-device"
  end

  test "production's config never turns it on" do
    for f <- ["config/prod.exs", "config/runtime.exs", "config/config.exs", "config/loadtest.exs"],
        do: refute(File.read!(f) =~ "any_device", f)
  end

  test "the page loads Bowser before the device check, and both before the app" do
    page = File.read!("priv/static/index.html")
    {b, _} = :binary.match(page, ~s(<script src="bowser.js">))
    {d, _} = :binary.match(page, ~s(<script src="device.js">))
    {a, _} = :binary.match(page, ~s(<script src="app.js">))
    assert b < d and d < a
  end

  test "Bowser is the version whose npm checksum was verified (an update is on purpose)" do
    # bowser-2.15.0.tgz: npm's sha512 matched; this file is its es5.js, unchanged
    assert :crypto.hash(:sha256, File.read!("priv/static/bowser.js"))
           |> Base.encode16(case: :lower) ==
             "fa1c0903e2e51e6980b685a46612b671a634df4d794fcde8c02e95b7f5b04d9f"

    assert File.read!("priv/static/bowser.LICENSE.txt") =~ "MIT License"
  end
end
