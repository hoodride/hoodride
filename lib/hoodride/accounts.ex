defmodule Hoodride.Accounts do
  @moduledoc "The one durable thing: who exists."

  import Ecto.Query
  alias Hoodride.Repo
  alias Hoodride.Accounts.User

  def get_user(id), do: Repo.get(User, id)

  @doc """
  A user for a long-lived process (a ride starting, a tap on the map): the
  user, nil (no such account) — or `{:error, :unavailable}` when the
  database can't answer under overload (the pool refusing a request,
  SQLite busy), so the caller carries on instead of crashing. Only those
  two: any other error is a bug and still raises. (`:user_lookup` swaps the
  lookup — tests use it to make the database fail.)
  """
  def profile(id) do
    Application.get_env(:hoodride, :user_lookup, &get_user/1).(id)
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error] -> {:error, :unavailable}
  end

  @doc """
  How long to wait before asking the database again after it couldn't
  answer: the pool's own patience (`queue_target` — how long it lets a
  request queue before it starts refusing), so the two stay in step.
  """
  def retry_wait_ms do
    Application.get_env(:hoodride, Hoodride.Repo, [])[:queue_target] || 1_000
  end

  @doc """
  Save a driver's car (ARCHITECTURE.md "Your car"): `{:ok, car}`,
  `{:error, :invalid, fields}` (which of "color", "make", "model" are
  wrong — nothing changed), or `{:error, :unavailable}` when the database
  couldn't answer. No such account: `{:error, :unavailable}` too (it was
  signed in a moment ago; it's being deleted).
  """
  def set_car(user_id, attrs) do
    with %User{} = u <- get_user(user_id) do
      case u |> User.car_changeset(attrs) |> Repo.update() do
        {:ok, u} ->
          {:ok, car(u)}

        {:error, cs} ->
          {:error, :invalid, Enum.map(Keyword.keys(cs.errors), &car_field/1) |> Enum.uniq()}
      end
    else
      nil -> {:error, :unavailable}
    end
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error] -> {:error, :unavailable}
  end

  @doc """
  The account agrees to the current Terms of Use (Hoodride.Terms): when and
  which version are saved — the proof. `:ok`, or `{:error, :unavailable}`
  when the database couldn't answer (or the account is gone: it's being
  deleted) — nothing saved, the app says "try again".
  """
  def agree_to_terms(user_id, at_ms \\ System.system_time(:millisecond)) do
    case from(u in User, where: u.id == ^user_id)
         |> Repo.update_all(
           set: [terms_accepted_at: at_ms, terms_version: Hoodride.Terms.version()]
         ) do
      {1, _} -> :ok
      {0, _} -> {:error, :unavailable}
    end
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error] -> {:error, :unavailable}
  end

  @doc "A driver's own car (Settings): `{:ok, car | nil}`, or `{:error, :unavailable}`."
  def car_of(user_id) do
    {:ok, user_id |> get_user() |> car()}
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error] -> {:error, :unavailable}
  end

  @doc ~s(What riders read: "Gray Honda Civic" — or nil, none set \(the app says "Driver"\).)
  # "Other" is no color to look for: just "Honda Civic"
  def car_label(%User{car_color: "Other", car_make: m, car_model: mo})
      when is_binary(m) and is_binary(mo),
      do: "#{m} #{mo}"

  def car_label(%User{car_color: c, car_make: m, car_model: mo})
      when is_binary(c) and is_binary(m) and is_binary(mo),
      do: "#{c} #{m} #{mo}"

  def car_label(_), do: nil

  defp car(%User{car_color: c, car_make: m, car_model: mo} = u) when is_binary(c),
    do: %{color: c, make: m, model: mo, label: car_label(u)}

  defp car(_), do: nil

  defp car_field(:car_color), do: "color"
  defp car_field(:car_make), do: "make"
  defp car_field(:car_model), do: "model"

  @doc "The photo an account has now (nil if none, or no such account) — sign-in keeps it if unchanged."
  def photo_of(provider, provider_id) do
    Repo.one(
      from(u in User,
        where: u.provider == ^provider and u.provider_id == ^provider_id,
        select: u.photo
      )
    )
  end

  @doc "Every profile photo of ours in use (Hoodride.Avatars' start-up clean-up)."
  def photos_in_use do
    from(u in User, where: like(u.photo, "/avatars/%"), select: u.photo)
    |> Repo.all()
    |> MapSet.new()
  end

  @doc """
  Several people at once, in ONE query: `{:ok, %{id => user}}` (an id with
  no account is simply absent), or `{:error, :unavailable}` when the
  database couldn't answer — only that; a bug still raises. (/api/state and
  reveal used to look each person up on their own.) The `:user_lookup` test
  seam, when set, stands in for the database id by id — a failure for any
  of them fails the whole lookup, as one query would.
  """
  def profiles(ids) do
    ids = Enum.uniq(ids)

    found =
      case Application.get_env(:hoodride, :user_lookup) do
        nil when ids == [] -> []
        nil -> Repo.all(from(u in User, where: u.id in ^ids))
        lookup -> for id <- ids, u = lookup.(id), u != nil, do: u
      end

    {:ok, Map.new(found, &{&1.id, &1})}
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error] -> {:error, :unavailable}
  end

  @doc """
  Sign the account out everywhere: every older session and socket token
  stops working. `:ok`, or `{:error, :failed}` when the database couldn't —
  then nothing changed.
  """
  def mark_logged_out(user_id, at_ms \\ System.system_time(:millisecond)) do
    # the database FIRST — its own table (survives a deletion, so restarts
    # keep refusing) and the column HTTP sessions still read — in one step.
    # If it can't, NOTHING changes and the caller says so: a sign-out the
    # server couldn't make is a failed sign-out (OWASP), never a half one
    # (it used to refuse in memory first: the socket refused, the HTTP
    # session still valid — an app that opened but never connected).
    {:ok, :ok} =
      Repo.transaction(fn ->
        from(u in User, where: u.id == ^user_id) |> Repo.update_all(set: [logged_out_at: at_ms])
        Hoodride.SignOuts.persist(user_id, at_ms)
      end)

    # then memory: refused from this instant
    Hoodride.SignOuts.put(user_id, at_ms)
    :ok
  rescue
    _ in [DBConnection.ConnectionError, Exqlite.Error] -> {:error, :failed}
  end

  @doc """
  The name strangers see: a FIRST name, as ride apps show — from the
  provider (name and photo can't be changed in Hood Ride; Google/Facebook own
  and moderate them, and a change there arrives at the next sign-in).

  The provider's own first-name field (Google `given_name`) — not a split of
  the full name ("Mary Ann Smith" is "Mary Ann"; family-name-first names
  would split wrong); without it, the full name's first word; without that,
  "Neighbor" — never the email (the old fallback showed it to strangers).
  Controls and format characters (zero-width, BOM, direction overrides and
  isolates — they fake or hide names) are dropped; NFC; spaces collapsed;
  at most 30 graphemes. The full name isn't stored.
  """
  def first_name(given, full) do
    case clean(given) do
      "" ->
        case full |> clean() |> String.split(" ", parts: 2) do
          [word | _] when word != "" -> word
          _ -> "Neighbor"
        end

      name ->
        name
    end
  end

  defp clean(nil), do: ""

  defp clean(text) when is_binary(text) do
    text
    |> String.replace(~r/[\p{Cc}\p{Cf}]/u, "")
    |> :unicode.characters_to_nfc_binary()
    |> String.replace(~r/\s+/u, " ")
    |> String.trim()
    |> String.slice(0, 30)
  end

  defp clean(_), do: ""

  @doc "Find-or-create a user from an OAuth profile, refreshing name/photo on each login."
  def upsert_oauth_user(attrs, id_source \\ &random_id/0) do
    case Repo.one(by_provider(attrs)) do
      nil -> create(attrs, id_source)
      user -> user |> User.oauth_changeset(attrs) |> Repo.update()
    end
  end

  defp by_provider(attrs),
    do:
      from(u in User,
        where: u.provider == ^attrs.provider and u.provider_id == ^attrs.provider_id
      )

  # RANDOM ids, not a count: every car and hand on the map carries its
  # owner's id, and sequential ids would tell anyone how many users exist
  # and how fast that grows (the "German tank problem"). Within JavaScript's
  # exact-integer range (2^53), and above 2^32 so they never meet the small
  # ids test fixtures use. Not a secret (that's what access checks are
  # for), just not a counter.
  @id_min 4_294_967_296
  @id_span 9_007_199_254_740_991 - @id_min

  @doc false
  def random_id do
    <<n::unsigned-size(64)>> = :crypto.strong_rand_bytes(8)
    @id_min + rem(n, @id_span)
  end

  # Two different clashes, two different meanings:
  #   - the random id is taken (astronomically rare) → draw another;
  #   - the same person was created a moment ago by a parallel login (a
  #     double tap, two tabs) → that user IS the answer.
  defp create(attrs, id_source, tries \\ 3) do
    case %User{id: id_source.()} |> User.oauth_changeset(attrs) |> Repo.insert() do
      {:ok, user} ->
        {:ok, user}

      {:error, changeset} ->
        cond do
          clash?(changeset, :id) and tries > 1 -> create(attrs, id_source, tries - 1)
          clash?(changeset, :provider) -> found_or_error(Repo.one(by_provider(attrs)), changeset)
          true -> {:error, changeset}
        end
    end
  end

  defp clash?(changeset, field),
    do:
      Enum.any?(changeset.errors, fn {f, {_, opts}} ->
        f == field and opts[:constraint] == :unique
      end)

  defp found_or_error(nil, changeset), do: {:error, changeset}
  defp found_or_error(user, _changeset), do: {:ok, user}
end
