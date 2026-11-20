defmodule HoodrideWeb.Health do
  @moduledoc """
  Can the database be WRITTEN? For GET /api/health — the deploy's own check
  (deploy/switch.sh) and deploy/check.sh. It asked /api/me, which with no
  session reads nothing: a release whose database was read-only or locked
  by something else passed, and every sign-in then failed (the 2026-11-08
  server review's note; done 2026-11-20).

  The write lock taken and a write made that changes nothing — an update
  no row matches — then rolled back: nothing is ever kept. At most once a second: the answer is kept for
  the rest of that second (the address is public — it can't be used to keep
  taking the lock).
  """
  alias Hoodride.Repo

  @every_ms 1_000

  @doc "`:ok` or `:down`."
  def check do
    slot = slot()
    now = System.monotonic_time(:millisecond)
    last = :atomics.get(slot, 1)

    # one asker a second does the work: the rest of it, its answer
    if last != 0 and now - last < @every_ms do
      answer(slot)
    else
      if :atomics.compare_exchange(slot, 1, last, now) == :ok do
        result = probe()
        :atomics.put(slot, 2, if(result == :ok, do: 1, else: 2))
        result
      else
        answer(slot)
      end
    end
  end

  @doc false
  # (tests) the kept answer forgotten
  def forget do
    slot = slot()
    :atomics.put(slot, 1, 0)
    :atomics.put(slot, 2, 0)
    :ok
  end

  # (no answer kept yet — another asker probing this instant: down until it says)
  defp answer(slot), do: if(:atomics.get(slot, 2) == 1, do: :ok, else: :down)

  defp probe do
    result =
      Repo.transaction(
        fn ->
          # a write that changes nothing (no row matches) — refused by a
          # database that can't be written (read-only, query_only); a fixed
          # statement, nothing put into it (Sobelow)
          Repo.query!("UPDATE schema_migrations SET version = version WHERE 0")
          Repo.rollback(:written)
        end,
        mode: :immediate
      )

    if result == {:error, :written}, do: :ok, else: :down
  rescue
    _ -> :down
  end

  # [last asked (monotonic ms; 0: never), answer (1 ok, 2 down, 0 none)]
  defp slot do
    case :persistent_term.get({__MODULE__, :slot}, nil) do
      nil ->
        a = :atomics.new(2, signed: true)
        :persistent_term.put({__MODULE__, :slot}, a)
        a

      a ->
        a
    end
  end
end
