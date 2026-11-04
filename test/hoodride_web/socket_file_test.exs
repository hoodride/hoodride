defmodule HoodrideWeb.SocketFileTest do
  @moduledoc """
  SOCKET_PATH: the app listens on a Unix socket. A stopped (or crashed) app
  leaves the socket FILE behind, and the next start then fails — "port 0
  already in use" (found in WSL with the prod release). So at start-up, before
  the endpoint listens:

    * no file: start;
    * a socket file nobody answers on: left over — delete it, start;
    * a socket file something answers on: another copy is running — refuse
      (taking its socket would cut it off from cloudflared);
    * not a socket (a mistyped SOCKET_PATH naming, say, the database): refuse,
      never delete.

  The decision is tested here with a stand-in probe (Windows can't open Unix
  sockets); the probe itself on a real socket is tagged :unix_socket and runs
  on Linux (`mix test --only unix_socket`, in WSL).
  """
  use ExUnit.Case, async: true

  alias HoodrideWeb.SocketFile

  defp tmp(name) do
    dir = Path.join(System.tmp_dir!(), "hoodride-sock-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)
    Path.join(dir, name)
  end

  # records what prepare/3 deleted
  defp recording_rm do
    me = self()

    fn path ->
      send(me, {:rm, path})
      :ok
    end
  end

  describe "at start-up" do
    test "no file: start, delete nothing" do
      assert SocketFile.prepare("/run/x.sock", fn _ -> :missing end, recording_rm()) == :ok
      refute_received {:rm, _}
    end

    test "left over (nobody answers): deleted, start" do
      assert SocketFile.prepare("/run/x.sock", fn _ -> :stale end, recording_rm()) == :ok
      assert_received {:rm, "/run/x.sock"}
    end

    test "another copy answers on it: refuse to start, delete nothing" do
      assert_raise RuntimeError, ~r/already running/, fn ->
        SocketFile.prepare("/run/x.sock", fn _ -> :live end, recording_rm())
      end

      refute_received {:rm, _}
    end

    test "not a socket (a mistyped path): refuse, never delete it" do
      assert_raise RuntimeError, ~r/not a socket/, fn ->
        SocketFile.prepare("/srv/hoodride.db", fn _ -> :not_socket end, recording_rm())
      end

      refute_received {:rm, _}
    end

    test "no folder for it: refuse, naming the folder (not a bare :enoent from the listener)" do
      assert_raise RuntimeError, ~r{folder /run/hoodride does not exist}, fn ->
        SocketFile.prepare("/run/hoodride/app.sock", fn _ -> :no_folder end, recording_rm())
      end
    end

    test "can't tell (say, no permission): refuse with the reason, delete nothing" do
      assert_raise RuntimeError, ~r/eacces/, fn ->
        SocketFile.prepare("/run/x.sock", fn _ -> {:error, :eacces} end, recording_rm())
      end

      refute_received {:rm, _}
    end

    test "a left-over file that can't be deleted: refuse with the reason" do
      assert_raise RuntimeError, ~r/eperm/, fn ->
        SocketFile.prepare("/run/x.sock", fn _ -> :stale end, fn _ -> {:error, :eperm} end)
      end
    end
  end

  describe "the probe" do
    test "a path with nothing there is :missing" do
      assert SocketFile.probe(tmp("none.sock")) == :missing
    end

    # found in WSL: /tmp was cleared, and the endpoint died with a bare :enoent
    test "the socket's folder doesn't exist: :no_folder" do
      assert SocketFile.probe(Path.join(tmp("gone"), "app.sock")) == :no_folder
    end

    test "a regular file is :not_socket (and is left alone)" do
      path = tmp("hoodride.db")
      File.write!(path, "data")
      assert SocketFile.probe(path) == :not_socket
      assert File.read!(path) == "data"
    end

    test "a folder is :not_socket" do
      path = tmp("dir")
      File.mkdir_p!(path)
      assert SocketFile.probe(path) == :not_socket
    end

    @tag :unix_socket
    test "a real socket: :live while listened on, :stale once its owner is gone, then reusable" do
      path = tmp("app.sock")

      owner =
        spawn(fn ->
          {:ok, l} = :gen_tcp.listen(0, [{:ifaddr, {:local, path}}])
          receive do: (:close -> :gen_tcp.close(l))
        end)

      Process.sleep(100)
      assert SocketFile.probe(path) == :live

      send(owner, :close)
      Process.sleep(100)
      # closing doesn't remove the file: exactly the restart problem
      assert File.exists?(path)
      assert SocketFile.probe(path) == :stale

      assert SocketFile.prepare(path) == :ok
      refute File.exists?(path)
      assert {:ok, l} = :gen_tcp.listen(0, [{:ifaddr, {:local, path}}])
      :gen_tcp.close(l)
    end
  end

  describe "which path" do
    test "the endpoint's Unix socket path, or nil when it listens on an IP" do
      assert SocketFile.listen_path(http: [ip: {:local, "/run/hoodride/app.sock"}, port: 0]) ==
               "/run/hoodride/app.sock"

      assert SocketFile.listen_path(http: [ip: {127, 0, 0, 1}, port: 4000]) == nil
      assert SocketFile.listen_path(http: [port: 4000]) == nil
      assert SocketFile.listen_path([]) == nil
    end
  end
end
