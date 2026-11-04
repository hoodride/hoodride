defmodule HoodrideWeb.SocketFile do
  @moduledoc """
  The Unix socket's FILE, before the endpoint listens on it (SOCKET_PATH,
  config/runtime.exs). A stopped or crashed app leaves the file behind and the
  next start fails ("port 0 already in use" — found in WSL with the prod
  release), so `Hoodride.Application` calls `prepare/1` first:

    * nothing there: start;
    * a socket nobody answers on: left over — delete it, start;
    * a socket something answers on: another copy is running — refuse (taking
      its path would cut it off from cloudflared);
    * not a socket (a mistyped SOCKET_PATH naming, say, the database), or
      can't tell: refuse, never delete.

  Not tied to systemd: its RuntimeDirectory also clears the folder, but a
  start by hand or another supervisor would still meet the old file.
  """

  @doc "Make the path free to listen on, or raise why it can't be."
  # sobelow_skip ["Traversal.FileModule"]
  def prepare(path, probe \\ &probe/1, rm \\ &File.rm/1) do
    case probe.(path) do
      :missing ->
        :ok

      :stale ->
        case rm.(path) do
          :ok -> :ok
          {:error, reason} -> raise "SOCKET_PATH #{path}: left over, can't delete it (#{reason})"
        end

      :live ->
        raise "SOCKET_PATH #{path}: another copy of the app is already running on it"

      :not_socket ->
        raise "SOCKET_PATH #{path}: there is a file there that is not a socket — not deleting it"

      # else the listener dies with a bare :enoent (systemd's RuntimeDirectory
      # makes the folder; by hand, or after /tmp is cleared, nothing does)
      :no_folder ->
        raise "SOCKET_PATH #{path}: its folder #{Path.dirname(path)} does not exist"

      {:error, reason} ->
        raise "SOCKET_PATH #{path}: can't check it (#{reason}) — not deleting it"
    end
  end

  @doc """
  What is at `path`: `:missing`, `:no_folder`, `:not_socket`, `:live`
  (something accepts a connection), `:stale` (a socket nobody listens on) or
  `{:error, reason}`.
  """
  def probe(path) do
    # lstat: a symlink is reported as one, never followed to what it names
    case File.lstat(path) do
      {:error, :enoent} -> if File.dir?(Path.dirname(path)), do: :missing, else: :no_folder
      # Erlang reports sockets as :other (as it does device files)
      {:ok, %File.Stat{type: :other}} -> connect(path)
      {:ok, %File.Stat{}} -> :not_socket
      {:error, reason} -> {:error, reason}
    end
  end

  defp connect(path) do
    case :gen_tcp.connect({:local, path}, 0, [], 1_000) do
      {:ok, socket} ->
        :gen_tcp.close(socket)
        :live

      {:error, :econnrefused} ->
        :stale

      {:error, :enoent} ->
        :missing

      # a busy listener (:timeout) or no permission: can't tell — refuse
      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc "The endpoint's Unix socket path from its config, or nil on an IP."
  def listen_path(endpoint_config) do
    case get_in(endpoint_config, [:http, :ip]) do
      {:local, path} -> path
      _ -> nil
    end
  end
end
