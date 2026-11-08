defmodule Hoodride.AvatarsTest do
  @moduledoc """
  Profile photos: one small copy made at sign-in, served by Hood Ride
  (ARCHITECTURE.md "Profile photos") — viewers never contact Google or
  Facebook, links can't rot, Facebook's Development-mode silhouettes are
  avoided by asking with the user's own token.

  Fetching follows OWASP's server-side-request rules: https, an allowlist
  of the providers' image hosts, NO redirects, a time and size limit, the
  type read from the bytes. Any failure keeps the current photo.
  """
  use ExUnit.Case, async: false

  alias Hoodride.Avatars

  @jpeg <<0xFF, 0xD8, 0xFF, 0xE0>> <> String.duplicate("j", 200)
  @png <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A>> <> String.duplicate("p", 200)
  @webp "RIFF" <> <<0, 0, 0, 0>> <> "WEBP" <> String.duplicate("w", 200)
  @google "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c"
  @graph "https://graph.facebook.com/v25.0/me/picture"

  setup do
    dir = Path.join(System.tmp_dir!(), "hoodride-avatars-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    old_dir = Application.get_env(:hoodride, :avatar_dir)
    old_req = Application.get_env(:hoodride, :avatar_req)
    Application.put_env(:hoodride, :avatar_dir, dir)
    Application.put_env(:hoodride, :avatar_req, plug: {Req.Test, Hoodride.Avatars})

    on_exit(fn ->
      Application.put_env(:hoodride, :avatar_dir, old_dir)
      Application.put_env(:hoodride, :avatar_req, old_req)
      File.rm_rf!(dir)
    end)

    %{dir: dir}
  end

  # a provider that answers `body` (and remembers what was asked)
  defp serve(fun) do
    test = self()

    Req.Test.stub(Hoodride.Avatars, fn conn ->
      send(
        test,
        {:asked, conn.host, conn.request_path, conn.query_string,
         Plug.Conn.get_req_header(conn, "authorization")}
      )

      fun.(conn)
    end)
  end

  defp image(conn, bytes), do: Plug.Conn.send_resp(conn, 200, bytes)

  defp file_of("/avatars/" <> name, dir), do: Path.join(dir, name)

  # true once `path` is gone, false if it's still there after `ms` (a timer
  # removes it: a fixed sleep lost the race on a busy machine)
  defp gone_within?(path, ms),
    do: gone_by?(path, System.monotonic_time(:millisecond) + ms)

  defp gone_by?(path, deadline) do
    cond do
      not File.exists?(path) ->
        true

      System.monotonic_time(:millisecond) > deadline ->
        false

      true ->
        Process.sleep(10)
        gone_by?(path, deadline)
    end
  end

  describe "Google" do
    test "asks for the 128 px square, stores it under a random name", %{dir: dir} do
      serve(&image(&1, @jpeg))
      photo = Avatars.from_google(@google, nil)

      assert_received {:asked, "lh3.googleusercontent.com", "/a/ACg8ocK=s128-c", _, _}
      assert photo =~ ~r|\A/avatars/[A-Za-z0-9_-]{22}\.jpg\z|
      assert File.read!(file_of(photo, dir)) == @jpeg
    end

    test "a link without a size gets one" do
      serve(&image(&1, @png))
      assert Avatars.from_google("https://lh3.googleusercontent.com/a/xyz", nil) =~ ~r/\.png\z/
      assert_received {:asked, _, "/a/xyz=s128-c", _, _}
    end

    test "the sized address failing: the link as given" do
      serve(fn conn ->
        if String.ends_with?(conn.request_path, "=s128-c"),
          do: Plug.Conn.send_resp(conn, 404, ""),
          else: image(conn, @webp)
      end)

      assert Avatars.from_google(@google, nil) =~ ~r/\.webp\z/
    end
  end

  describe "Facebook" do
    test "asks with the user's own token, never redirected; downloads the url Facebook gives" do
      serve(fn conn ->
        case conn.host do
          "graph.facebook.com" ->
            Req.Test.json(conn, %{
              "data" => %{
                "url" => "https://scontent.xx.fbcdn.net/p.jpg",
                "is_silhouette" => false
              }
            })

          "scontent.xx.fbcdn.net" ->
            image(conn, @jpeg)
        end
      end)

      assert Avatars.from_facebook("fb-user-token", nil, @graph) =~ ~r/\.jpg\z/

      assert_received {:asked, "graph.facebook.com", "/v25.0/me/picture", q,
                       ["Bearer fb-user-token"]}

      assert URI.decode_query(q) == %{"redirect" => "0", "width" => "128", "height" => "128"}
    end

    test "only Facebook's silhouette: no photo (🙂), nothing downloaded" do
      serve(fn conn ->
        Req.Test.json(conn, %{
          "data" => %{"url" => "https://scontent.xx.fbcdn.net/s.jpg", "is_silhouette" => true}
        })
      end)

      assert Avatars.from_facebook("t", "/avatars/old", @graph) == nil
      refute_received {:asked, "scontent.xx.fbcdn.net", _, _, _}
    end
  end

  describe "what is refused (the current photo is kept)" do
    test "not an image — whatever the header says" do
      serve(fn conn ->
        conn
        |> Plug.Conn.put_resp_content_type("image/jpeg")
        |> Plug.Conn.send_resp(200, "<html>nope</html>")
      end)

      assert Avatars.from_google(@google, "/avatars/kept.jpg") == "/avatars/kept.jpg"
    end

    test "bigger than 512 KB" do
      serve(&image(&1, @jpeg <> String.duplicate("x", 600_000)))
      assert Avatars.from_google(@google, nil) == nil
    end

    test "a redirect is never followed — even to an allowed host" do
      # following it would find a perfectly good photo: refusing is the rule
      # (a redirect can lead anywhere past the host check)
      serve(fn conn ->
        if conn.request_path == "/elsewhere.jpg",
          do: image(conn, @jpeg),
          else:
            conn
            |> Plug.Conn.put_resp_header(
              "location",
              "https://lh3.googleusercontent.com/elsewhere.jpg"
            )
            |> Plug.Conn.send_resp(302, "")
      end)

      assert Avatars.from_google(@google, nil) == nil
      refute_received {:asked, _, "/elsewhere.jpg", _, _}
    end

    test "hosts outside the allowlist, or plain http, are never asked" do
      serve(&image(&1, @jpeg))

      for url <- [
            "https://evil.example/a.jpg",
            "http://lh3.googleusercontent.com/a/x",
            "https://googleusercontent.com.evil.example/a",
            "https://evilgoogleusercontent.com/a",
            nil,
            "not a url"
          ],
          do: assert(Avatars.from_google(url, nil) == nil)

      refute_received {:asked, _, _, _, _}

      serve(fn conn ->
        Req.Test.json(conn, %{
          "data" => %{"url" => "https://evil.example/p.jpg", "is_silhouette" => false}
        })
      end)

      assert Avatars.from_facebook("t", nil, @graph) == nil
      refute_received {:asked, "evil.example", _, _, _}
    end

    test "no answer at all" do
      Req.Test.stub(Hoodride.Avatars, &Req.Test.transport_error(&1, :timeout))
      assert Avatars.from_google(@google, nil) == nil
    end
  end

  describe "storing" do
    test "the same photo again keeps its name (browser caches stay valid)", %{dir: dir} do
      serve(&image(&1, @jpeg))
      first = Avatars.from_google(@google, nil)
      assert Avatars.from_google(@google, first) == first
      assert length(File.ls!(dir)) == 1
    end

    test "a new photo gets a new name; the old file stays a while, then goes", %{dir: dir} do
      Application.put_env(:hoodride, :avatar_keep_ms, 50)
      on_exit(fn -> Application.delete_env(:hoodride, :avatar_keep_ms) end)

      serve(&image(&1, @jpeg))
      old = Avatars.from_google(@google, nil)
      serve(&image(&1, @png))
      new = Avatars.from_google(@google, old)

      assert new != old
      assert {:ok, :saved} = Avatars.keep_if_saved(new, old, fn -> {:ok, :saved} end)
      assert File.exists?(file_of(old, dir)), "kept a while: links handed out earlier still work"
      assert gone_within?(file_of(old, dir), 5_000), "the old file was never removed"
      assert File.exists?(file_of(new, dir))
    end

    # the account's save comes AFTER the download: the old photo is retired
    # only once the account points at the new one — a database failure used
    # to leave the account pointing at a file deleted a day later (server
    # review, 2026-11-08)
    test "fetching alone never retires the old photo", %{dir: dir} do
      Application.put_env(:hoodride, :avatar_keep_ms, 50)
      on_exit(fn -> Application.delete_env(:hoodride, :avatar_keep_ms) end)

      serve(&image(&1, @jpeg))
      old = Avatars.from_google(@google, nil)
      serve(&image(&1, @png))
      _new = Avatars.from_google(@google, old)
      refute gone_within?(file_of(old, dir), 300), "retired before the account was saved"
    end

    test "the save failing or raising: the NEW file goes at once, the old one stays", %{dir: dir} do
      Application.put_env(:hoodride, :avatar_keep_ms, 50)
      on_exit(fn -> Application.delete_env(:hoodride, :avatar_keep_ms) end)

      serve(&image(&1, @jpeg))
      old = Avatars.from_google(@google, nil)

      for outcome <- [:error, :raise] do
        serve(&image(&1, @png <> Atom.to_string(outcome)))
        new = Avatars.from_google(@google, old)
        assert new != old

        save =
          case outcome do
            :error -> fn -> {:error, :changeset} end
            :raise -> fn -> raise DBConnection.ConnectionError, "connection not available" end
          end

        if outcome == :raise do
          assert_raise DBConnection.ConnectionError, fn ->
            Avatars.keep_if_saved(new, old, save)
          end
        else
          assert {:error, :changeset} = Avatars.keep_if_saved(new, old, save)
        end

        refute File.exists?(file_of(new, dir)), "#{outcome}: the unused new file was left behind"
      end

      refute gone_within?(file_of(old, dir), 300), "the old photo is still the account's"
    end

    test "the same photo (unchanged): nothing removed either way", %{dir: dir} do
      serve(&image(&1, @jpeg))
      photo = Avatars.from_google(@google, nil)
      assert {:error, :x} = Avatars.keep_if_saved(photo, photo, fn -> {:error, :x} end)
      assert {:ok, :y} = Avatars.keep_if_saved(photo, photo, fn -> {:ok, :y} end)
      assert File.exists?(file_of(photo, dir))
    end

    test "remove/1 deletes our file now; anything else is left alone", %{dir: dir} do
      serve(&image(&1, @jpeg))
      photo = Avatars.from_google(@google, nil)
      :ok = Avatars.remove(photo)
      refute File.exists?(file_of(photo, dir))

      for other <- [nil, "https://lh3.googleusercontent.com/x", "/avatars/../../etc/passwd"],
          do: :ok = Avatars.remove(other)
    end

    test "start-up removes files nothing points to (older than a day), never one in use", %{
      dir: dir
    } do
      day = 86_400

      for name <-
            ~w(aaaaaaaaaaaaaaaaaaaaaa.jpg bbbbbbbbbbbbbbbbbbbbbb.jpg cccccccccccccccccccccc.jpg),
          do: File.write!(Path.join(dir, name), @jpeg)

      old = System.os_time(:second) - 2 * day
      File.touch!(Path.join(dir, "aaaaaaaaaaaaaaaaaaaaaa.jpg"), old)
      File.touch!(Path.join(dir, "bbbbbbbbbbbbbbbbbbbbbb.jpg"), old)

      :ok = Avatars.sweep_orphans(MapSet.new(["/avatars/bbbbbbbbbbbbbbbbbbbbbb.jpg"]))

      assert Enum.sort(File.ls!(dir)) == [
               "bbbbbbbbbbbbbbbbbbbbbb.jpg",
               "cccccccccccccccccccccc.jpg"
             ]
    end

    test "names: only ours are valid" do
      assert Avatars.valid_name?("aaaaaaaaaaaaaaaaaaaaaa.jpg")
      assert Avatars.valid_name?("A-_b9Zaaaaaaaaaaaaaaaa.webp")

      for bad <- [
            "../etc/passwd",
            "a.jpg",
            "aaaaaaaaaaaaaaaaaaaaaa.svg",
            "aaaaaaaaaaaaaaaaaaaaaa.jpg/x",
            "aaaaaaaaaaaaaaaaaaaaaa.jpg\n"
          ],
          do: refute(Avatars.valid_name?(bad), bad)
    end
  end
end
