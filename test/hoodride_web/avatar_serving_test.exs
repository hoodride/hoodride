defmodule HoodrideWeb.AvatarServingTest do
  @moduledoc """
  Profile photos end to end (Hoodride.Avatars): a sign-in makes our own
  copy; `/avatars/:name` serves it to signed-in people only, with headers
  that keep it private and inert, on its own budget; deleting the account
  deletes the file; links stored before are cleared by a migration; the
  privacy policy says so.
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Avatars, Repo}

  @jpeg <<0xFF, 0xD8, 0xFF, 0xE0>> <> String.duplicate("j", 200)
  @png <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A>> <> String.duplicate("p", 200)

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    dir = Path.join(System.tmp_dir!(), "hoodride-avs-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)

    saved =
      for k <- [
            :avatar_dir,
            :avatar_req,
            :avatar_budget,
            :google_client_id,
            :google_client_secret,
            :google_req
          ],
          do: {k, Application.get_env(:hoodride, k)}

    Application.put_env(:hoodride, :avatar_dir, dir)
    Application.put_env(:hoodride, :avatar_req, plug: {Req.Test, Avatars})
    Application.put_env(:hoodride, :google_client_id, "test-id")
    Application.put_env(:hoodride, :google_client_secret, "test-secret")
    Application.put_env(:hoodride, :google_req, plug: {Req.Test, HoodrideWeb.Google})

    on_exit(fn ->
      for {k, v} <- saved,
          do:
            if(v == nil,
              do: Application.delete_env(:hoodride, k),
              else: Application.put_env(:hoodride, k, v)
            )

      File.rm_rf!(dir)
    end)

    %{dir: dir}
  end

  defp user(key, photo \\ nil) do
    {:ok, u} =
      Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key, photo: photo})

    u
  end

  defp signed_in(conn, u),
    do:
      init_test_session(conn, %{
        user_id: u.id,
        signed_in_at: System.system_time(:millisecond),
        name: u.name,
        photo: u.photo,
        provider: u.provider
      })

  defp stored(dir, bytes) do
    name = Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false) <> ".jpg"
    File.write!(Path.join(dir, name), bytes)
    name
  end

  describe "a Google sign-in" do
    test "makes our own copy; the account's photo is our address", %{conn: conn, dir: dir} do
      Req.Test.stub(Avatars, &Plug.Conn.send_resp(&1, 200, @jpeg))

      conn = get(conn, "/auth/google")
      q = URI.decode_query(URI.parse(redirected_to(conn, 302)).query)

      Req.Test.stub(HoodrideWeb.Google, fn c ->
        case c.request_path do
          "/token" ->
            Req.Test.json(c, %{"access_token" => "at"})

          "/oauth2/v3/userinfo" ->
            Req.Test.json(c, %{
              "sub" => "g-av",
              "given_name" => "Ava",
              "picture" => "https://lh3.googleusercontent.com/a/ava=s96-c"
            })
        end
      end)

      conn = get(recycle(conn), "/auth/google/callback", %{"code" => "c", "state" => q["state"]})
      assert redirected_to(conn, 302) == "/"

      photo = Accounts.photo_of("google", "g-av")
      assert "/avatars/" <> name = photo
      assert File.read!(Path.join(dir, name)) == @jpeg
    end
  end

  describe "serving" do
    test "a signed-in person gets it: an image, kept privately, inert", %{conn: conn, dir: dir} do
      name = stored(dir, @jpeg)
      res = get(signed_in(conn, user("av-v")), "/avatars/#{name}")

      assert res.status == 200
      assert res.resp_body == @jpeg
      assert get_resp_header(res, "content-type") == ["image/jpeg"]
      assert get_resp_header(res, "cache-control") == ["private, max-age=31536000, immutable"]
      assert get_resp_header(res, "x-content-type-options") == ["nosniff"]
      assert get_resp_header(res, "content-security-policy") == ["default-src 'none'; sandbox"]
    end

    test "signed out: nothing", %{conn: conn, dir: dir} do
      name = stored(dir, @jpeg)
      assert get(conn, "/avatars/#{name}").status == 401
    end

    test "only our names: anything else is 404, nothing outside the folder", %{
      conn: conn,
      dir: dir
    } do
      File.write!(Path.join(dir, "secret.txt"), "no")
      conn = signed_in(conn, user("av-n"))

      for path <- [
            "/avatars/secret.txt",
            "/avatars/aaaaaaaaaaaaaaaaaaaaaa.jpg",
            "/avatars/..%2F..%2Fmix.exs",
            "/avatars/aaaaaaaaaaaaaaaaaaaaaa.svg"
          ],
          do: assert(get(conn, path).status == 404, path)
    end

    test "its own budget: the burst (40, plus the one every budget here allows), then 429 — and the app's other calls unaffected",
         %{conn: conn, dir: dir} do
      # a slow refill, so the test measures the burst alone
      Application.put_env(:hoodride, :avatar_budget, per_minute: 1, burst: 40)
      name = stored(dir, @jpeg)
      conn = signed_in(conn, user("av-b"))

      # Hoodride.RateBudget (GCRA) allows burst + 1 at once, like every budget here
      statuses = for _ <- 1..42, do: get(conn, "/avatars/#{name}").status
      assert Enum.count(statuses, &(&1 == 200)) == 41
      assert List.last(statuses) == 429
      assert json_response(get(conn, "/api/me"), 200)["user"]
    end

    test "the photo budget stays twice reveal's (burst and per minute)" do
      limits = Application.get_env(:hoodride, :avatar_budget) || [per_minute: 120, burst: 40]
      assert limits[:burst] == 2 * HoodrideWeb.WorldChannel.reveal_max()
      assert limits[:per_minute] == 2 * HoodrideWeb.WorldChannel.reveal_per_minute()

      config = Config.Reader.read!("config/config.exs", env: :prod)[:hoodride][:avatar_budget]
      assert config == [per_minute: 120, burst: 40]
    end
  end

  test "deleting the account deletes its photo at once", %{conn: conn, dir: dir} do
    name = stored(dir, @png)
    u = user("av-del", "/avatars/#{name}")

    assert json_response(
             post(signed_in(conn, u), "/api/account/delete", %{"confirm" => true}),
             200
           )

    refute File.exists?(Path.join(dir, name))
  end

  test "a delete the database can't do leaves the photo too", %{conn: conn, dir: dir} do
    name = stored(dir, @png)
    u = user("av-del2", "/avatars/#{name}")
    Repo.query!("ALTER TABLE sign_outs RENAME TO sign_outs_away")
    assert post(signed_in(conn, u), "/api/account/delete", %{"confirm" => true}).status == 503
    assert File.exists?(Path.join(dir, name))
  end

  test "the migration clears links to Google/Facebook; ours and dev-login photos stay" do
    mod =
      Hoodride.TestHelpers.migration(
        "priv/repo/migrations/20261027042532_clear_outside_photos.exs"
      )

    ids =
      for {provider, photo} <- [
            {"google", "https://lh3.googleusercontent.com/a/x"},
            {"facebook", "https://graph.facebook.com/v25.0/1/picture?type=large"},
            {"google", "/avatars/aaaaaaaaaaaaaaaaaaaaaa.jpg"},
            {"dev", "data:image/svg+xml,x"}
          ] do
        {:ok, u} =
          Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "m-#{photo}", name: "m"})

        Repo.query!("UPDATE users SET provider = ?, photo = ? WHERE id = ?", [
          provider,
          photo,
          u.id
        ])

        u.id
      end

    Repo.query!(mod.clear_sql())
    photos = Enum.map(ids, &Accounts.get_user(&1).photo)
    assert photos == [nil, nil, "/avatars/aaaaaaaaaaaaaaaaaaaaaa.jpg", "data:image/svg+xml,x"]
  end

  test "the privacy policy says a rider's messages and requests share roughly where they are" do
    html = File.read!("priv/static/privacy.html")
    assert html =~ "People you message or ask for a ride, when you're not driving"
    assert html =~ "an area about 350 m (about a quarter mile) across, never your exact position"
  end

  test "the privacy policy says photos are copied and served by Hood Ride" do
    html = File.read!("priv/static/privacy.html")
    assert html =~ "small copy of your profile photo"
    assert html =~ "Google doesn't see who looks at whose photo"
    refute html =~ "so they can see when a photo is shown"
    refute html =~ "photo link"
  end
end
