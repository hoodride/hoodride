defmodule Hoodride.WarmStart do
  @moduledoc """
  The warm start (owner, 2026-11-18). Sign-ins and blocks are read on
  demand (Hoodride.SessionTokens, Hoodride.Blocks), so after a deploy
  everyone reconnecting at once read the database person by person —
  4,000 people on 2 cores: everyone back after 52.7 s. The standard fix
  (MySQL's buffer-pool dump at shutdown / load at start-up, on by
  default; AWS's RDS docs): remember WHO was in memory, not the data.

    * `save/0` — a polite stop (`Hoodride.Application.prep_stop/1`, before
      anything shuts down, so everyone's still connected): the account
      numbers of everyone connected, to a file next to the database
      (written aside, then renamed: never half a file).
    * `load/0` — the next start, before the Sweeper and the web server:
      the file read ONCE and deleted at once, then those people's
      sign-ins and blocks in a few big reads (500 people each). Fresh
      from the database — a list of numbers can't be stale; anyone signed
      out meanwhile is simply known to have none.

  Anything wrong — no file (a crash, a first start), one it can't read,
  one too old (`max_age_ms`), the database, the time allowed (`max_ms`):
  logged, and the start goes on loading on demand, exactly as without it.
  People who don't come back are dropped by the Sweeper's first pass (a
  minute in), as anyone gone.

  Only at a polite stop, by the owner's choice: a crash leaves no list.
  To cover crashes too, `save/0` could also run every minute or so (AWS's
  advice for MySQL; a few KB per thousand people — a file, never a table)
  — not built.

  `config :hoodride, :warm_start, path:, max_age_ms:, max_ms:` — `path`:
  `:next_to_database` (default), a file, or nil (off: tests).
  """
  require Logger
  alias Hoodride.{Blocks, SessionTokens}

  @list_format 1
  @per_read 500

  @doc false
  def child_spec(_),
    do: %{id: __MODULE__, start: {__MODULE__, :start_link, []}, restart: :transient}

  @doc false
  # the start-up step: load, then step aside — never stops the start
  def start_link do
    _ = load()
    :ignore
  end

  @doc "Who's connected, to the file: `{:ok, how_many}`, `:off` or `:error` (logged)."
  # the path is the server's own setting (next to the database), never a
  # visitor's input
  # sobelow_skip ["Traversal.FileModule"]
  def save(now \\ now()) do
    case path() do
      nil ->
        :off

      path ->
        ids = connected()
        tmp = path <> ".tmp"
        File.mkdir_p!(Path.dirname(path))
        File.write!(tmp, :erlang.term_to_binary({:hoodride_warm_start, @list_format, now, ids}))
        File.rename!(tmp, path)
        Logger.info("warm start: saved #{length(ids)} connected for the next start")
        {:ok, length(ids)}
    end
  rescue
    e ->
      Logger.warning(
        "warm start: couldn't save who's connected (#{Exception.message(e)}) — the next start loads on demand"
      )

      :error
  end

  @doc """
  The file, read once: `{:ok, loaded}`, `{:partial, loaded}` (out of time
  or the database failed — the rest on demand), `:none` (no file),
  `:skipped` (unreadable or too old), `:off`, `:error`.
  """
  # (the path: the server's own setting, as save/1)
  # sobelow_skip ["Traversal.FileModule"]
  def load(now \\ now()) do
    case path() do
      nil ->
        :off

      path ->
        case File.read(path) do
          {:error, :enoent} ->
            :none

          {:error, reason} ->
            _ = File.rm(path)
            skipped("couldn't be read (#{inspect(reason)})")

          {:ok, bin} ->
            # gone before anything is loaded: never read twice
            _ = File.rm(path)

            case decode(bin, now) do
              {:ok, ids} -> preload(ids)
              {:skip, why} -> skipped(why)
            end
        end
    end
  rescue
    e ->
      Logger.warning("warm start: failed (#{Exception.message(e)}) — loading on demand")
      :error
  end

  defp skipped(why) do
    Logger.warning("warm start: the saved list #{why} — skipped, loading on demand")
    :skipped
  end

  # a file only this server writes, in its own data folder — and read with
  # `:safe` all the same (no atoms or function references made from it;
  # WarmStartTest "names nothing this server knows"); anything but the
  # expected shape is skipped
  # sobelow_skip ["Misc.BinToTerm"]
  defp decode(bin, now) do
    case :erlang.binary_to_term(bin, [:safe]) do
      {:hoodride_warm_start, @list_format, saved_at, ids}
      when is_integer(saved_at) and is_list(ids) ->
        if abs(now - saved_at) <= cfg(:max_age_ms, 600_000),
          do: {:ok, ids |> Enum.filter(&(is_integer(&1) and &1 > 0)) |> Enum.uniq()},
          else: {:skip, "is too old"}

      _ ->
        {:skip, "isn't one this version reads"}
    end
  rescue
    ArgumentError -> {:skip, "isn't readable"}
  end

  # a chunk at a time, sign-ins then blocks; a chunk is whole or not at all
  # for each (the "loaded" mark goes in after its rows)
  defp preload(ids) do
    started = System.monotonic_time(:millisecond)
    budget = cfg(:max_ms, 10_000)

    {done, why} =
      ids
      |> Enum.chunk_every(@per_read)
      |> Enum.reduce_while({0, nil}, fn chunk, {n, _} ->
        if System.monotonic_time(:millisecond) - started > budget do
          {:halt, {n, "out of time (#{budget} ms)"}}
        else
          try do
            :ok = SessionTokens.preload_many(chunk)
            :ok = Blocks.preload_many(chunk)
            {:cont, {n + length(chunk), nil}}
          rescue
            e -> {:halt, {n, "the database failed (#{Exception.message(e)})"}}
          end
        end
      end)

    ms = System.monotonic_time(:millisecond) - started

    if why do
      Logger.warning(
        "warm start: #{done} of #{length(ids)} loaded in #{ms} ms — #{why}; the rest on demand"
      )

      {:partial, done}
    else
      Logger.info("warm start: #{done} people's sign-ins and blocks loaded in #{ms} ms")
      {:ok, done}
    end
  end

  @doc "Everyone with an app connected now (account numbers, once each)."
  def connected do
    Hoodride.UserChannels
    |> Registry.select([{{:"$1", :_, :_}, [], [:"$1"]}])
    |> Enum.filter(&is_integer/1)
    |> Enum.uniq()
  end

  @doc false
  def path do
    case cfg(:path, :next_to_database) do
      :next_to_database ->
        case Application.get_env(:hoodride, Hoodride.Repo)[:database] do
          db when is_binary(db) -> Path.join(Path.dirname(db), "warm_start.bin")
          _ -> nil
        end

      other ->
        other
    end
  end

  defp cfg(key, default),
    do: Keyword.get(Application.get_env(:hoodride, :warm_start, []), key, default)

  defp now, do: System.system_time(:millisecond)
end
