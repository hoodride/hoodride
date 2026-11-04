defmodule Hoodride.ServerHardeningTest do
  # The server's locks, as the repo installs them (2026-11-02): the app's
  # service is fenced in (systemd-analyze security: 6.8 MEDIUM → 1.5 OK), and
  # setup.sh --harden lets no one in over SSH as root, by password, or fast.
  use ExUnit.Case, async: true

  @service File.read!("deploy/hoodride.service")
  @setup File.read!("deploy/setup.sh")

  defp setting?(line), do: @service |> String.split("\n") |> Enum.member?(line)

  test "the app's service: no special powers, no clock, kernel log or other programs" do
    for line <- ~w(
          CapabilityBoundingSet= AmbientCapabilities= ProtectClock=true
          ProtectKernelLogs=true ProtectHostname=true ProtectProc=invisible
          LockPersonality=true RestrictRealtime=true RestrictNamespaces=true
          RemoveIPC=true SystemCallArchitectures=native
          SystemCallFilter=@system-service NoNewPrivileges=true ProtectSystem=strict
        ) do
      assert setting?(line), "missing: #{line}"
    end

    assert setting?("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK")
  end

  test "never MemoryDenyWriteExecute: the BEAM's JIT writes the code it runs" do
    refute @service =~ ~r/^MemoryDenyWriteExecute=true/m
  end

  test "setup.sh --harden: no root login over SSH, checked before the reload" do
    assert @setup =~ "'PermitRootLogin no'"
    assert @setup =~ "grep -qx 'permitrootlogin no'"
  end

  test "setup.sh --harden: SSH rate-limited, not just allowed" do
    assert @setup =~ "ufw limit OpenSSH"
    refute @setup =~ "ufw allow OpenSSH"
  end

  # the server's clock is UTC, and nothing names where the owner lives
  # (owner, 2026-11-03: open-source prep): security fixes still install and,
  # only if one needs it, restart overnight in the US (3–5 AM Central)
  test "server clock: UTC, updates overnight in the US, no home time zone named" do
    assert @setup =~ "timedatectl set-timezone Etc/UTC\n"
    assert File.read!("deploy/apt-daily.timer.conf") =~ "\nOnCalendar=*-*-* 08:30\n"
    assert File.read!("deploy/apt-daily-upgrade.timer.conf") =~ "\nOnCalendar=*-*-* 09:00\n"

    assert File.read!("deploy/apt-auto-reboot.conf") =~
             ~s(Unattended-Upgrade::Automatic-Reboot-Time "10:00";)

    for file <-
          Path.wildcard("deploy/*") ++ ["ARCHITECTURE.md", "GOOGLE_SETUP.md", "SELF_HOSTING.md"] do
      text = File.read!(file)
      refute text =~ ~r{America/|US Central|\b(Eastern|Central|Mountain|Pacific) time}i, file
      # nor the old local hours
      refute text =~ ~r/\b(02:30|03:00|04:00)\b/, file
    end
  end
end
