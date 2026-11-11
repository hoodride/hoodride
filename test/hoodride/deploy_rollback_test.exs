defmodule Hoodride.DeployRollbackTest do
  @moduledoc """
  A deploy that fails after its database changes (owner, 2026-11-11,
  reproduced by hand first): the old version came back onto the changed
  database and failed every sign-in — and passed the deploy's check. Now:
  the database is copied before the new version starts (deploy/db_copy.sh),
  put back when it fails, and a version that can't read the database
  refuses to start (Hoodride.SchemaCheck).
  """
  use ExUnit.Case

  @script "deploy/db_copy.sh"
  @tag_a "20261111-090000"
  @tag_b "20261111-100000"

  setup do
    root = Path.join(System.tmp_dir!(), "hr_rollback_#{System.unique_integer([:positive])}")
    dir = Path.join(root, "db")
    copies = Path.join(root, "copies")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf(root) end)
    %{root: root, dir: dir, copies: copies}
  end

  defp sh(ctx, args, more_env \\ []) do
    env = [
      {"HOODRIDE_DB_DIR", slash(ctx.dir)},
      {"HOODRIDE_DB_COPIES", slash(ctx.copies)} | more_env
    ]

    System.cmd("bash", [@script | args], env: env, stderr_to_stdout: true)
  end

  defp slash(path), do: String.replace(path, "\\", "/")

  # C:/Users/… as WSL sees it: /mnt/c/Users/…
  defp wsl_path(path) do
    [drive, rest] = path |> slash() |> String.split(":/", parts: 2)
    "/mnt/" <> String.downcase(drive) <> "/" <> rest
  end

  defp db(ctx, f \\ "hoodride.db"), do: Path.join(ctx.dir, f)

  describe "db_copy.sh" do
    test "snapshot, then a change, then restore: exactly the bytes before; the scratch index dropped",
         ctx do
      File.write!(db(ctx), "before")
      File.write!(db(ctx, "hoodride.db-wal"), "wal before")
      File.write!(db(ctx, "hoodride.db-shm"), "index")
      assert {_, 0} = sh(ctx, ["snapshot", @tag_a])

      # the new version's changes
      File.write!(db(ctx), "after — a column gone")
      File.write!(db(ctx, "hoodride.db-wal"), "wal after")

      assert {out, 0} = sh(ctx, ["restore", @tag_a])
      assert out =~ "put back"
      assert File.read!(db(ctx)) == "before"
      assert File.read!(db(ctx, "hoodride.db-wal")) == "wal before"
      refute File.exists?(db(ctx, "hoodride.db-shm"))
    end

    test "the very first deploy (no database yet): putting it back means no database again",
         ctx do
      assert {_, 0} = sh(ctx, ["snapshot", @tag_a])
      File.write!(db(ctx), "made by the new version")
      assert {_, 0} = sh(ctx, ["restore", @tag_a])
      refute File.exists?(db(ctx))
    end

    test "a copy that never finished is never put back: an error, the database untouched", ctx do
      File.write!(db(ctx), "live")
      File.mkdir_p!(Path.join(ctx.copies, @tag_a))
      File.write!(Path.join([ctx.copies, @tag_a, "hoodride.db"]), "half")
      assert {out, code} = sh(ctx, ["restore", @tag_a])
      assert code != 0 and out =~ "no finished copy"
      assert File.read!(db(ctx)) == "live"
    end

    # putting it back failing half-way (a full disk, a missing file): the
    # live database must be exactly as it was — never gone or half-written
    # (an empty one gets created at start and looks like "no accounts")
    test "putting back failing half-way: the database left exactly as it was", ctx do
      File.write!(db(ctx), "live")
      File.write!(db(ctx, "hoodride.db-wal"), "live wal")
      assert {_, 0} = sh(ctx, ["snapshot", @tag_a])
      File.write!(db(ctx), "changed by the new version")
      File.write!(db(ctx, "hoodride.db-wal"), "changed wal")
      # the copy's -wal missing: the second file can't be copied
      File.rm!(Path.join([ctx.copies, @tag_a, "hoodride.db-wal"]))

      assert {_, code} = sh(ctx, ["restore", @tag_a])
      assert code != 0
      assert File.read!(db(ctx)) == "changed by the new version"
      assert File.read!(db(ctx, "hoodride.db-wal")) == "changed wal"

      assert File.ls!(ctx.dir) |> Enum.sort() == ["hoodride.db", "hoodride.db-wal"],
             "a half-finished file left behind"
    end

    # a copy failing half-way must not leave its half behind: copies of
    # failed deploys are never pruned, and they'd fill the disk under the
    # running app
    test "a copy failing half-way leaves nothing behind", ctx do
      File.write!(db(ctx), "live")
      # (its -wal a folder: that file can't be copied)
      File.mkdir_p!(db(ctx, "hoodride.db-wal"))
      assert {_, code} = sh(ctx, ["snapshot", @tag_a])
      assert code != 0
      refute File.exists?(Path.join(ctx.copies, @tag_a))
      assert File.read!(db(ctx)) == "live"
    end

    # not enough room for the copy (and as much again to spare): refused
    # before anything is written — the running app keeps its free space
    test "not enough free disk for the copy: refused before writing anything", ctx do
      File.write!(db(ctx), String.duplicate("x", 10_000))
      assert {out, code} = sh(ctx, ["snapshot", @tag_a], [{"HOODRIDE_DB_FREE_BYTES", "15000"}])
      assert code != 0 and out =~ "free", out
      refute File.exists?(Path.join(ctx.copies, @tag_a))
      # plenty: copied
      assert {_, 0} = sh(ctx, ["snapshot", @tag_a], [{"HOODRIDE_DB_FREE_BYTES", "10000000"}])
    end

    test "only release names: anything else refused (no path in or out of the copies folder)",
         ctx do
      File.write!(db(ctx), "live")

      for bad <- ["../x", "", "20261111", "20261111-090000/../..", "a b"] do
        assert {out, code} = sh(ctx, ["snapshot", bad])
        assert code != 0 and out =~ "not a release name", inspect({bad, out})
      end

      refute File.exists?(ctx.copies)
    end

    test "prune keeps the newest N copies, removes the older ones", ctx do
      File.write!(db(ctx), "x")

      tags = [
        "20261101-000000",
        "20261102-000000",
        "20261103-000000",
        "20261104-000000",
        "20261105-000000"
      ]

      for t <- tags, do: assert({_, 0} = sh(ctx, ["snapshot", t]))

      assert {_, 0} = sh(ctx, ["prune", "3"])
      assert Enum.sort(File.ls!(ctx.copies)) == Enum.take(tags, -3)
      assert {_, code} = sh(ctx, ["prune", "0"])
      assert code != 0
    end
  end

  # switch.sh RUN for real (its own bash, the real db_copy.sh): only the
  # service manager and the health check are stand-ins — a fake systemctl
  # logging each stop/start, whose start of the NEW release "changes the
  # database" (as a migration would), and a health check per release.
  # ("current" is a file holding the path: no symlinks on this machine —
  # the same scenarios were also run in Linux with real symlinks.)
  describe "switch.sh" do
    @old "20261111-080000"
    @new "20261111-090000"

    setup ctx do
      app = Path.join(ctx.root, "app")
      for r <- [@old, @new], do: File.mkdir_p!(Path.join([app, "releases", r]))
      File.write!(Path.join(app, "current"), slash(Path.join([app, "releases", @old])))
      File.write!(db(ctx), "accounts v1\n")

      systemctl = Path.join(ctx.root, "systemctl.sh")

      File.write!(systemctl, """
      #!/bin/bash
      rel="$(basename "$(cat "$FAKE_APP/current")")"
      case "$1" in
        stop) echo "stop" >> "$FAKE_APP/log"; [ -e "$FAKE_APP/stop_fails" ] && exit 1; exit 0 ;;
        start)
          echo "start $rel" >> "$FAKE_APP/log"
          [ -e "$FAKE_APP/start_fails_$rel" ] && exit 1
          [ "$rel" = "#{@new}" ] && echo "changed by the new version" >> "$FAKE_DB/hoodride.db"
          exit 0 ;;
      esac
      """)

      dbcopy = Path.join(ctx.root, "dbcopy.sh")

      File.write!(
        dbcopy,
        ~s(#!/bin/bash\nexec bash "#{slash(File.cwd!())}/deploy/db_copy.sh" "$@"\n)
      )

      %{app: app, systemctl: systemctl, dbcopy: dbcopy}
    end

    # health: a file per release saying it answers; anything else, given
    defp switch(ctx, opts \\ []) do
      rel = ~s[$(basename "$(cat "$FAKE_APP/current")")]
      healthy = Keyword.get(opts, :healthy, ~s([ -e "$FAKE_APP/healthy_#{rel}" ]))
      new = slash(Path.join([ctx.app, "releases", @new]))

      System.cmd("bash", ["deploy/switch.sh", new],
        env: switch_env(ctx, healthy),
        stderr_to_stdout: true
      )
    end

    defp switch_env(ctx, healthy) do
      [
        {"HOODRIDE_DB_DIR", slash(ctx.dir)},
        {"HOODRIDE_DB_COPIES", slash(ctx.copies)},
        {"HOODRIDE_APP", slash(ctx.app)},
        {"HOODRIDE_CURRENT_FILE", "1"},
        {"HOODRIDE_SYSTEMCTL", slash(ctx.systemctl)},
        {"HOODRIDE_DBCOPY", slash(ctx.dbcopy)},
        {"HOODRIDE_HEALTHY", healthy},
        {"HOODRIDE_DEPLOY_LOG", slash(Path.join(ctx.root, "deploy.log"))},
        {"FAKE_APP", slash(ctx.app)},
        {"FAKE_DB", slash(ctx.dir)}
      ]
    end

    defp healthy!(ctx, rel), do: File.write!(Path.join(ctx.app, "healthy_" <> rel), "")
    defp live(ctx), do: ctx.app |> Path.join("current") |> File.read!() |> Path.basename()

    defp log(ctx) do
      case File.read(Path.join(ctx.app, "log")) do
        {:ok, text} -> String.split(text, "\n", trim: true)
        _ -> []
      end
    end

    test "the new release answers: it's live, its database changes kept", ctx do
      healthy!(ctx, @new)
      assert {out, 0} = switch(ctx)
      assert out =~ "live:"
      assert live(ctx) == @new
      assert log(ctx) == ["stop", "start #{@new}"]
      assert File.read!(db(ctx)) =~ "changed by the new version"
      assert File.exists?(Path.join([ctx.copies, @new, "complete"]))
    end

    test "the new release doesn't answer: the database put back, THEN the old one started", ctx do
      healthy!(ctx, @old)
      assert {out, 1} = switch(ctx)
      assert out =~ "switched back"
      assert live(ctx) == @old
      assert log(ctx) == ["stop", "start #{@new}", "stop", "start #{@old}"]
      assert File.read!(db(ctx)) == "accounts v1\n"
    end

    test "the new release's start itself fails: rolled back the same way (never left on it)",
         ctx do
      healthy!(ctx, @old)
      File.write!(Path.join(ctx.app, "start_fails_" <> @new), "")
      assert {_, 1} = switch(ctx)
      assert live(ctx) == @old
      assert List.last(log(ctx)) == "start #{@old}"
      assert File.read!(db(ctx)) == "accounts v1\n"
    end

    test "the copy can't be made: nothing switched, the running release starts again, the database untouched",
         ctx do
      # (the copies' folder can't be made: a file is in its place)
      File.write!(ctx.copies, "in the way")
      assert {out, 1} = switch(ctx)
      assert out =~ "couldn't copy the database"
      assert live(ctx) == @old
      assert log(ctx) == ["stop", "start #{@old}"]
      assert File.read!(db(ctx)) == "accounts v1\n"
    end

    test "the copy can't be put back: the app left STOPPED — never the old one on a changed database",
         ctx do
      healthy!(ctx, @old)
      # the check fails AND the copy's gone by then
      gone = ~s(rm -f "#{slash(Path.join([ctx.copies, @new, "complete"]))}"; false)
      assert {out, 1} = switch(ctx, healthy: gone)
      assert out =~ "left STOPPED"
      assert List.last(log(ctx)) == "stop"
      refute "start #{@old}" in log(ctx)
    end

    test "cut off after the switch (a dropped connection): rolled back — never left on an unchecked release",
         ctx do
      healthy!(ctx, @old)
      # the deploy killed during its check
      assert {_, code} = switch(ctx, healthy: "kill -TERM $PPID; sleep 1; false")
      assert code != 0
      assert live(ctx) == @old
      assert List.last(log(ctx)) == "start #{@old}"
      assert File.read!(db(ctx)) == "accounts v1\n"
    end

    # an ssh connection dropping: the deploy's output goes nowhere (writing
    # to it fails or kills) AND it gets a hang-up. The rollback must still
    # run to the end — it used to die on its first message
    test "the connection dropped during the check (output gone, hung up): still rolled back to the end",
         ctx do
      healthy!(ctx, @old)
      env = switch_env(ctx, "kill -HUP $PPID; sleep 1; false")
      new = slash(Path.join([ctx.app, "releases", @new]))
      # (its output a pipe whose reader is already gone)
      System.cmd("bash", ["-c", ~s(bash deploy/switch.sh "#{new}" | true)], env: env)
      assert live(ctx) == @old
      assert List.last(log(ctx)) == "start #{@old}"
      assert File.read!(db(ctx)) == "accounts v1\n"
      # what it said is kept in the deploy log
      assert File.read!(Path.join(ctx.root, "deploy.log")) =~ "switched back"
    end

    # …the same on LINUX, as on the server: there a dead output KILLS the
    # writer (here it only errors — this machine can't show the bug).
    # Through WSL where it exists; proven failing on the switch.sh before
    # this fix (left live on the new release, its database changed).
    # (Linux: its own bash; Windows: through WSL; neither: SKIPPED, shown as
    # such — never a silent pass)
    @linux (case :os.type() do
              {:unix, _} -> :native
              _ -> if System.find_executable("wsl.exe"), do: :wsl, else: nil
            end)
    @tag :wsl
    if @linux == nil, do: @tag(skip: "no Linux to run it on (install WSL)")

    test "on Linux: the connection dropped during the check — rolled back to the end" do
      {cmd, proj} =
        case @linux do
          :native -> {"bash", File.cwd!()}
          :wsl -> {"wsl.exe", wsl_path(File.cwd!())}
        end

      args = [proj <> "/test/deploy/dropped_connection.sh", proj, proj <> "/deploy/switch.sh"]
      args = if @linux == :wsl, do: ["bash" | args], else: args
      {out, _} = System.cmd(cmd, args, stderr_to_stdout: true)

      out = String.replace(out, "\r", "")
      assert out =~ "live: #{@old}", out
      assert out =~ "log: stop,start #{@new},stop,start #{@old},", out
      assert out =~ "db: accounts v1|\n", out
    end

    # a deploy log it can't write (another user's file, a read-only disk):
    # the rollback still puts the database back and starts the old release
    test "a deploy log it can't write never blocks the rollback", ctx do
      healthy!(ctx, @old)
      # (the log's path is a folder: it can't be written)
      bad_log = Path.join(ctx.root, "log_is_a_folder")
      File.mkdir_p!(bad_log)

      env =
        switch_env(ctx, ~S{[ -e "$FAKE_APP/healthy_$(basename "$(cat "$FAKE_APP/current")")" ]})
        |> List.keystore("HOODRIDE_DEPLOY_LOG", 0, {"HOODRIDE_DEPLOY_LOG", slash(bad_log)})

      new = slash(Path.join([ctx.app, "releases", @new]))

      assert {out, 1} =
               System.cmd("bash", ["deploy/switch.sh", new], env: env, stderr_to_stdout: true)

      assert out =~ "switched back", out
      assert live(ctx) == @old
      assert File.read!(db(ctx)) == "accounts v1\n"
    end

    # the app couldn't be stopped for the rollback: nothing put back —
    # renaming files under a running app's open database corrupts it
    test "the app can't be stopped for the rollback: the database NOT touched under it", ctx do
      healthy!(ctx, @old)
      stops_fail = ~s(touch "$FAKE_APP/stop_fails"; false)
      assert {out, 1} = switch(ctx, healthy: stops_fail)
      assert out =~ "couldn't stop the app", out
      assert File.read!(db(ctx)) =~ "changed by the new version"
      refute "start #{@old}" in log(ctx)
    end

    test "cut off during the copy: the running release starts again, nothing switched", ctx do
      stop_then_die = Path.join(ctx.root, "dbcopy_dies.sh")
      File.write!(stop_then_die, "#!/bin/bash\nkill -TERM $PPID\nsleep 1\nexit 1\n")
      env_ctx = %{ctx | dbcopy: stop_then_die}
      assert {_, code} = switch(env_ctx)
      assert code != 0
      assert live(ctx) == @old
      assert log(ctx) == ["stop", "start #{@old}"]
      assert File.read!(db(ctx)) == "accounts v1\n"
    end
  end

  describe "deploy.sh" do
    test "switches through switch.sh — stopping there if it isn't live — then checks and prunes" do
      d = File.read!("deploy/deploy.sh")
      [_, after_build] = String.split(d, ~s(mix hoodride.minify), parts: 2)

      assert after_build =~
               ~r/\A[^\n]*\n\n(#[^\n]*\n)*"\$\(dirname "\$0"\)\/switch\.sh" "\$NEW"\n/

      [_, after_switch] = String.split(after_build, ~s(switch.sh" "$NEW"), parts: 2)
      assert after_switch =~ "cloudflare_check.sh"
      assert after_switch =~ ~s(db_copy.sh" prune 3)
      refute d =~ "systemctl", "deploy.sh itself never stops or starts the app (switch.sh does)"
      assert d =~ "set -euo pipefail"
    end
  end

  # The sequence reproduced by hand, automatic: the real migrations, a real
  # database file, the real copy script, the real start-up check
  describe "the whole sequence" do
    @new_version """
    defmodule Hoodride.DeployRollbackTest.NewVersionChange do
      use Ecto.Migration

      def change do
        alter table(:users) do
          add :car, :string
          remove :car_make
        end
      end
    end
    """

    defp start_db(ctx) do
      {:ok, pid} =
        Hoodride.Repo.start_link(
          name: nil,
          database: db(ctx),
          pool: DBConnection.ConnectionPool,
          pool_size: 1
        )

      Hoodride.Repo.put_dynamic_repo(pid)
      pid
    end

    defp stop_db(pid) do
      Hoodride.Repo.put_dynamic_repo(Hoodride.Repo)
      Supervisor.stop(pid)
    end

    defp migrate(pid, paths),
      do: Ecto.Migrator.run(Hoodride.Repo, paths, :up, all: true, dynamic_repo: pid, log: false)

    test "new version's change, it fails, the copy put back: the old version reads the database again",
         ctx do
      live = Application.app_dir(:hoodride, "priv/repo/migrations")
      # (forward slashes: the migration file search finds nothing through a
      # Windows backslash path)
      new_dir = slash(Path.join(ctx.root, "new_migrations"))
      File.mkdir_p!(new_dir)
      File.write!(Path.join(new_dir, "20990101000000_new_version_change.exs"), @new_version)

      # the old version, live: its database as it reads it
      pid = start_db(ctx)
      migrate(pid, [live])
      assert Hoodride.SchemaCheck.run() == :ignore
      stop_db(pid)

      # the deploy: copied (stopped), the new version starts and changes it…
      assert {_, 0} = sh(ctx, ["snapshot", @tag_b])
      pid = start_db(ctx)
      migrate(pid, [live, new_dir])
      # …and fails. Without the copy, the old version can't read this:
      assert {:error, {:database_unreadable, Hoodride.Accounts.User, msg}} =
               Hoodride.SchemaCheck.run()

      assert msg =~ "car_make"
      stop_db(pid)

      # put back: the old version reads it as before
      assert {_, 0} = sh(ctx, ["restore", @tag_b])
      pid = start_db(ctx)
      assert Hoodride.SchemaCheck.run() == :ignore
      stop_db(pid)
    end
  end
end
