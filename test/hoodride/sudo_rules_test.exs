defmodule Hoodride.SudoRulesTest do
  @moduledoc """
  What your server account may do as root without a password (sudo review,
  2026-11-13). The deploy needed a few root steps, and the old rules gave
  away much more:

    * `bash ~/hoodride/deploy/db_copy.sh *` as root — a script in your OWN
      folder (every deploy replaces it): edit it, and it runs anything as
      root;
    * `curl` as cloudflared with any options — read the tunnel's key, write
      its files;
    * and the server itself had `NOPASSWD: ALL` (90-hood): any process of
      your account was root, no question asked.

  Now (deploy/sudo_rules.sh): exact service commands, plus three fixed
  helpers installed root-owned in /usr/local/sbin; everything else asks for
  the account's password. The catch-all is removed LAST, and only once a
  password is set — never a lock-out.
  """
  use ExUnit.Case, async: true

  @rules File.read!("deploy/sudo_rules.sh")
  @deploy_scripts ~w(deploy/deploy.sh deploy/switch.sh deploy/cloudflare_check.sh deploy/errors.sh deploy/setup.sh)

  defp sudoers(text) do
    [_, body] = Regex.run(~r/<<EOF\n(.*?)\nEOF/s, text)
    body
  end

  test "the rules: exact service commands and root-owned helpers — nothing open-ended" do
    rules = sudoers(@rules)

    for line <- String.split(rules, "\n", trim: true) do
      assert line =~ ~r/^\$ADMIN ALL=\((root|cloudflared)\) NOPASSWD: /, line
      commands = line |> String.split("NOPASSWD: ", parts: 2) |> List.last()

      for cmd <- String.split(commands, ", ") do
        assert cmd in [
                 "/usr/bin/systemctl restart hoodride",
                 "/usr/bin/systemctl stop hoodride",
                 "/usr/bin/systemctl start hoodride",
                 "/usr/local/sbin/hoodride-db-copy",
                 "/usr/local/sbin/hoodride-host",
                 "/usr/local/sbin/hoodride-socket-get"
               ],
               "an open-ended rule: #{cmd}"
      end
    end

    # the tunnel check runs as cloudflared, the rest as root
    assert rules =~ "(cloudflared) NOPASSWD: /usr/local/sbin/hoodride-socket-get"
    refute rules =~ "(root) NOPASSWD: /usr/local/sbin/hoodride-socket-get"
  end

  test "the helpers are copies owned by root — never run from your own folder" do
    for {from, to} <- [
          {"db_copy.sh", "hoodride-db-copy"},
          {"socket_get.sh", "hoodride-socket-get"},
          {"host.sh", "hoodride-host"}
        ] do
      assert @rules =~ ~s(install -o root -g root -m 0755 "$HERE/#{from}" /usr/local/sbin/#{to}),
             "#{from} isn't installed root-owned"
    end

    # the rules file: checked before it's put in place, never half-written
    assert @rules =~
             ~r/visudo -cf "\$tmp".*\n.*install -o root -g root -m 0440 "\$tmp" \/etc\/sudoers\.d\/hoodride-deploy/
  end

  test "the password-free catch-all goes LAST, and only once there's a password" do
    [before, removal] = String.split(@rules, "# ---- last: the catch-all", parts: 2)
    # everything else first
    assert before =~ "/etc/sudoers.d/hoodride-deploy"
    assert before =~ "usermod -aG systemd-journal"
    # a locked or empty password: kept (else nothing could become root)
    assert removal =~ ~s(passwd -S "$ADMIN")
    assert removal =~ ~r/\[ "\$pw" = P \]/
    # and still able to with one: in the sudo group
    assert removal =~ "id -nG \"$ADMIN\""
    # moved aside, not deleted (put back by hand if ever needed), then checked
    assert removal =~ "mv "
    assert removal =~ "visudo -c"
  end

  test "the deploy never runs sudo on a file in your folder, or curl" do
    for f <- @deploy_scripts do
      src = File.read!(f)

      for line <- String.split(src, "\n"),
          # (comments, and the advice it prints: not commands)
          not String.starts_with?(String.trim_leading(line), ["#", "echo "]),
          line =~ ~r/\bsudo\b/ do
        refute line =~ ~r/sudo[^|;]*\/usr\/bin\/(bash|curl)\b/, "#{f}: #{line}"
        refute line =~ ~r/sudo[^|;]*(\$HERE|\$PWD|\$\(dirname)/, "#{f}: #{line}"
        refute line =~ ~r/sudo -n grep/, "#{f}: #{line}"
      end
    end

    # setup.sh writes no rules of its own: sudo_rules.sh does
    setup = File.read!("deploy/setup.sh")
    refute setup =~ "/etc/sudoers.d/hoodride-deploy <<"
    assert setup =~ ~s(bash "$HERE/sudo_rules.sh")
  end

  test "a deploy stops if the installed helpers aren't this version's" do
    d = File.read!("deploy/deploy.sh")
    [before_build, _] = String.split(d, "mix release", parts: 2)
    assert before_build =~ "cmp -s"
    assert before_build =~ "sudo_rules.sh"
  end

  test "the log is read as a member of the log readers, not with sudo — and a missing membership is a FAIL, not 'nothing went wrong'" do
    e = File.read!("deploy/errors.sh")
    refute e =~ "sudo -n journalctl"
    assert e =~ "systemd-journal"
  end

  describe "hoodride-socket-get (deploy/socket_get.sh)" do
    # run for real (bash), up to the point it would ask: a refused argument
    # never reaches curl
    defp run(args),
      do: System.cmd("bash", ["deploy/socket_get.sh" | args], stderr_to_stdout: true)

    test "refuses anything but a plain path and host" do
      for args <- [
            [],
            ["api/me"],
            ["/api/me?x=1"],
            ["/x y"],
            ["/x", "-o/etc/passwd"],
            ["/x", "evil.example/@other"],
            ["--status", "-K/etc/cloudflared/cert.pem"],
            ["/a;id"]
          ] do
        assert {_, 2} = run(args), "accepted: #{inspect(args)}"
      end
    end
  end
end
