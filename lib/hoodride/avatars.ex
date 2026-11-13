defmodule Hoodride.Avatars do
  @moduledoc """
  Profile photos: ONE small copy, made at sign-in, served by Hood Ride
  (`/avatars/<name>`, HoodrideWeb.AvatarController) — ARCHITECTURE.md
  "Profile photos". They used to be hotlinked: every viewer's phone asked
  Google/Facebook, telling them who looked at whom; Google's links can rot
  into a silhouette between sign-ins; and Facebook's tokenless picture
  address returns a SILHOUETTE for apps in Development mode (Meta's own
  reference) — so Facebook is asked with the signed-in user's own token.

  Fetching follows OWASP's server-side-request rules: https only, an
  allowlist of the providers' image hosts, NO redirects (they bypass the
  check), #{div(3_000, 1000)} s, at most 512 KB, and the type read from the
  BYTES (JPEG, PNG, WebP) — never the header. Any failure keeps the current
  photo: a sign-in never fails for a photo.

  Files live next to the database (`:avatar_dir`) under random names
  (unguessable, uncountable). The same photo again keeps its name (browser
  caches stay valid); a new one gets a new name and, once the account is
  saved with it (`keep_if_saved/3`), the old file is kept a day — socket
  tokens carry the old link that long — then removed.
  Deleting the account removes it at once; start-up removes any file
  nothing points to.
  """
  require Logger

  @max_bytes Hoodride.Limits.avatar_bytes()
  @timeout_ms Hoodride.Limits.avatar_fetch_ms()
  @size Hoodride.Limits.avatar_px()
  @google_hosts [".googleusercontent.com"]
  @facebook_hosts [".fbcdn.net", ".fbsbx.com"]
  @name ~r/\A[A-Za-z0-9_-]{22}\.(jpg|png|webp)\z/

  @doc "The folder the photos live in."
  def dir, do: Application.fetch_env!(:hoodride, :avatar_dir)

  @doc "Is `name` one of ours (a random name, a known type)? Nothing else is ever served."
  def valid_name?(name) when is_binary(name), do: Regex.match?(@name, name)
  def valid_name?(_), do: false

  @doc "Google: the `picture` link from sign-in, at #{@size} px (the documented `=s128-c`), else as given."
  def from_google(url, current) do
    if allowed?(url, @google_hosts) do
      with :error <- fetch(sized(url), @google_hosts),
           :error <- fetch(url, @google_hosts) do
        current
      else
        {:ok, bytes, ext} -> store(bytes, ext, current)
      end
    else
      current
    end
  end

  @doc """
  Facebook: asked with the signed-in user's own token (`redirect=0`: the
  picture's details as data, never a redirect). Only the silhouette on
  offer: no photo (the app shows 🙂).
  """
  def from_facebook(token, current, graph_url) do
    opts = [params: [redirect: 0, width: @size, height: @size], auth: {:bearer, token}]

    case Req.get(graph_url, opts ++ base_opts()) do
      {:ok, %{status: 200, body: %{"data" => %{"is_silhouette" => true}}}} ->
        nil

      {:ok, %{status: 200, body: %{"data" => %{"url" => url}}}} ->
        case fetch(url, @facebook_hosts) do
          {:ok, bytes, ext} -> store(bytes, ext, current)
          :error -> current
        end

      _ ->
        current
    end
  end

  @doc """
  Save an account with its new photo (`save` returns `{:ok, _}` or anything
  else): the OLD photo is retired only once the account points at the new
  one; if the save fails or raises, the NEW file — which nothing points to
  — goes at once. Fetching never retires anything itself: a database
  failure after the download used to leave the account pointing at a file
  deleted a day later (server review, 2026-11-08).
  """
  def keep_if_saved(new, old, save) do
    case save.() do
      {:ok, _} = saved ->
        if new != old, do: retire(old)
        saved

      failed ->
        if new != old, do: remove(new)
        failed
    end
  rescue
    e ->
      if new != old, do: remove(new)
      reraise e, __STACKTRACE__
  end

  @doc "Remove our file for `photo` now (account deletion); anything else is left alone."
  # sobelow_skip ["Traversal.FileModule"]
  def remove("/avatars/" <> name) do
    if valid_name?(name), do: File.rm(Path.join(dir(), name))
    :ok
  end

  def remove(_), do: :ok

  @doc """
  Start-up: remove the files nothing points to (`referenced`, the photos in
  use), once older than the keep time — a replaced photo past its day, or
  one left by a crash between writing and saving.
  """
  # sobelow_skip ["Traversal.FileModule"]
  def sweep_orphans(referenced) do
    cutoff = System.os_time(:second) - div(keep_ms(), 1000)

    for file <- File.ls!(dir()),
        not MapSet.member?(referenced, "/avatars/" <> file),
        path = Path.join(dir(), file),
        {:ok, %{mtime: mtime}} <- [File.stat(path, time: :posix)],
        mtime < cutoff,
        do: File.rm(path)

    :ok
  end

  # ---- fetching ----

  defp base_opts do
    [redirect: false, retry: false, receive_timeout: @timeout_ms] ++
      Application.get_env(:hoodride, :avatar_req, [])
  end

  defp fetch(url, hosts) do
    with true <- allowed?(url, hosts),
         {:ok, %{status: 200, body: body}} when is_binary(body) and byte_size(body) <= @max_bytes <-
           Req.get(url, [decode_body: false] ++ base_opts()),
         ext when is_binary(ext) <- kind(body) do
      {:ok, body, ext}
    else
      _ -> :error
    end
  end

  # https, and a host that IS one of theirs (the dot: "x.googleusercontent.com",
  # never "googleusercontent.com.evil.example")
  defp allowed?(url, hosts) when is_binary(url) do
    case URI.parse(url) do
      %URI{scheme: "https", host: host} when is_binary(host) ->
        Enum.any?(hosts, &String.ends_with?(host, &1))

      _ ->
        false
    end
  end

  defp allowed?(_, _), do: false

  # Google's size options follow the last "=" (People API image sizing)
  defp sized(url) do
    if Regex.match?(~r/=[^\/=]*\z/, url),
      do: Regex.replace(~r/=[^\/=]*\z/, url, "=s#{@size}-c"),
      else: url <> "=s#{@size}-c"
  end

  # the type from the bytes themselves
  defp kind(<<0xFF, 0xD8, 0xFF, _::binary>>), do: "jpg"
  defp kind(<<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, _::binary>>), do: "png"
  defp kind(<<"RIFF", _::binary-size(4), "WEBP", _::binary>>), do: "webp"
  defp kind(_), do: nil

  # ---- storing ----

  # sobelow_skip ["Traversal.FileModule"]
  defp store(bytes, ext, current) do
    if same?(current, bytes) do
      current
    else
      name = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false) <> "." <> ext
      tmp = Path.join(dir(), ".tmp-" <> name)

      with :ok <- File.mkdir_p(dir()),
           :ok <- File.write(tmp, bytes),
           :ok <- File.rename(tmp, Path.join(dir(), name)) do
        "/avatars/" <> name
      else
        error ->
          File.rm(tmp)
          Logger.warning("couldn't store a profile photo: #{inspect(error)}")
          current
      end
    end
  end

  # sobelow_skip ["Traversal.FileModule"]
  defp same?("/avatars/" <> name, bytes) do
    valid_name?(name) and File.read(Path.join(dir(), name)) == {:ok, bytes}
  end

  defp same?(_, _), do: false

  # a photo no longer in use: removed after the keep time (links handed out
  # in the last day — socket tokens — still work meanwhile)
  defp retire("/avatars/" <> _ = photo) do
    {:ok, _} = :timer.apply_after(keep_ms(), __MODULE__, :remove, [photo])
    :ok
  end

  defp retire(_), do: :ok

  defp keep_ms, do: Application.get_env(:hoodride, :avatar_keep_ms, 86_400_000)

  # ---- start-up ----

  @doc false
  def child_spec(_),
    do: %{id: __MODULE__, start: {__MODULE__, :start_link, []}, restart: :transient}

  @doc false
  # the folder exists; files nothing points to go (then step aside). Tidying:
  # a folder that can't be made or read (permissions, a missing mount) is
  # logged and the start goes on — it used to stop the whole app from
  # starting (crash review 2026-11-13; Hoodride.BootResilienceTest). Photos
  # then simply aren't kept until it's fixed; sign-in still works.
  # sobelow_skip ["Traversal.FileModule"]
  def start_link do
    File.mkdir_p!(dir())
    sweep_orphans(Hoodride.Accounts.photos_in_use())
    :ignore
  rescue
    e in [File.Error, Exqlite.Error, DBConnection.ConnectionError] ->
      Logger.warning(
        "start-up: profile photos folder not ready (#{Exception.message(e)}) — skipped"
      )

      :ignore
  end
end
