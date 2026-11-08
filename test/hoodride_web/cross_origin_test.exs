defmodule HoodrideWeb.CrossOriginTest do
  @moduledoc """
  Batch B (server review, 2026-11-08):

    * requests that change something come from Hood Ride's own pages only
      (HoodrideWeb.CrossOrigin — Go's CrossOriginProtection rule): the
      browser's `Sec-Fetch-Site`, else the `Origin` against the request's
      own address, else (not a modern browser) allowed;
    * only small JSON is read (64 KB; forms and uploads up to 8 MB used to
      be); delete account and save car take JSON only, their fields from
      the BODY only (`?confirm=DELETE` counted whatever the body said).

  ConnTest's own requests are http://www.example.com (port 80).
  """
  use HoodrideWeb.ConnCase, async: false

  # (the refusals' warning lines: asserted where it matters, kept out of the output)
  @moduletag :capture_log

  import ExUnit.CaptureLog

  alias Hoodride.Accounts

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "co-u", name: "Cora"})
    :ok = Accounts.agree_to_terms(u.id)
    %{u: Accounts.get_user(u.id)}
  end

  defp signed_in(u), do: init_test_session(build_conn(), Hoodride.TestHelpers.session_for(u.id))

  defp with_headers(conn, headers), do: %{conn | req_headers: conn.req_headers ++ headers}

  defp json_post(conn, path, body),
    do:
      conn
      |> put_req_header("content-type", "application/json")
      |> post(path, if(is_binary(body), do: body, else: Jason.encode!(body)))

  # a sign-out (signed out: a harmless 200) asked with these headers
  defp logout_with(headers),
    do: build_conn() |> with_headers(headers) |> json_post("/api/logout", %{}) |> Map.get(:status)

  describe "the browser says where the request comes from" do
    test "this same site, or typed by the person: allowed" do
      assert logout_with([{"sec-fetch-site", "same-origin"}]) == 200
      assert logout_with([{"sec-fetch-site", "none"}]) == 200
    end

    test "another site — a subdomain too — or the header twice: refused, 403" do
      for headers <- [
            [{"sec-fetch-site", "cross-site"}],
            [{"sec-fetch-site", "same-site"}],
            [{"sec-fetch-site", "same-origin"}, {"sec-fetch-site", "same-origin"}]
          ] do
        assert logout_with(headers) == 403, inspect(headers)
      end
    end

    test "the browser's signal wins over the Origin (as Go's)" do
      assert logout_with([{"sec-fetch-site", "cross-site"}, {"origin", "http://www.example.com"}]) ==
               403
    end
  end

  describe "no signal, an Origin: it must be this very address" do
    test "the same scheme, host and port: allowed (any case)" do
      assert logout_with([{"origin", "http://www.example.com"}]) == 200
      assert logout_with([{"origin", "http://WWW.Example.COM"}]) == 200
    end

    test "another scheme, host or port, null, malformed, extra parts, or twice: refused" do
      for origin <- [
            "https://www.example.com",
            # only the scheme differs (same port written out)
            "https://www.example.com:80",
            "http://evil.example",
            "http://www.example.com:4000",
            "null",
            "garbage",
            "http://user@www.example.com",
            "http://www.example.com/path",
            ""
          ] do
        assert logout_with([{"origin", origin}]) == 403, origin
      end

      assert logout_with([
               {"origin", "http://www.example.com"},
               {"origin", "http://www.example.com"}
             ]) ==
               403
    end

    test "a phone on home Wi-Fi (http, an address and a port), and IPv6" do
      lan = %{build_conn() | host: "192.168.1.20", port: 4000}

      assert lan
             |> with_headers([{"origin", "http://192.168.1.20:4000"}])
             |> json_post("/api/logout", %{})
             |> Map.get(:status) == 200

      v6 = %{build_conn() | host: "[::1]", port: 4000}

      assert v6
             |> with_headers([{"origin", "http://[::1]:4000"}])
             |> json_post("/api/logout", %{})
             |> Map.get(:status) == 200
    end

    test "neither signal nor Origin (not a browser): allowed" do
      assert logout_with([]) == 200
    end
  end

  describe "where it applies" do
    test "every request that changes something: sign out, Terms, delete, car, dev login" do
      for path <- ~w(/api/logout /api/terms/accept /api/account/delete /api/car /api/dev_login) do
        res =
          %{build_conn() | host: "localhost"}
          |> with_headers([{"sec-fetch-site", "cross-site"}])
          |> json_post(path, %{})

        assert json_response(res, 403) == %{"error" => "cross_site"}, path
      end
    end

    test "never reading (GET), never the CSP reports (Safari sends Origin: null)" do
      res = build_conn() |> with_headers([{"sec-fetch-site", "cross-site"}]) |> get("/api/car")
      assert res.status == 401

      res =
        build_conn()
        |> with_headers([{"sec-fetch-site", "cross-site"}, {"origin", "null"}])
        |> json_post("/api/csp-report", %{})

      refute res.status == 403
    end

    test "a refused one: logged by kind only (no address), counted" do
      me = self()
      id = {__MODULE__, :refused}

      :telemetry.attach(
        id,
        [:hoodride, :cross_origin, :refused],
        fn _, _, meta, _ -> send(me, {:refused, meta.kind}) end,
        nil
      )

      log =
        capture_log(fn ->
          assert logout_with([{"origin", "http://evil.example"}]) == 403
        end)

      :telemetry.detach(id)
      assert_received {:refused, "another origin"}
      assert log =~ "cross-site request refused: another origin"
      refute log =~ "evil.example"
    end
  end

  describe "only small JSON" do
    test "delete account and save car: JSON only (a form body: 415), after the sign-in check", %{
      u: u
    } do
      for path <- ["/api/account/delete", "/api/car"] do
        res =
          signed_in(u)
          |> put_req_header("content-type", "application/x-www-form-urlencoded")
          |> post(path, "confirm=DELETE&color=Gray&make=Honda&model=Civic")

        assert json_response(res, 415) == %{"error" => "json_only"}, path
      end

      assert Accounts.get_user(u.id)
      # signed out: still "not signed in" first
      res =
        build_conn()
        |> put_req_header("content-type", "text/plain")
        |> post("/api/car", "x")

      assert json_response(res, 401)
    end

    test "the word only from the body: ?confirm=DELETE in the address doesn't count", %{u: u} do
      res = signed_in(u) |> json_post("/api/account/delete?confirm=DELETE", %{})
      assert json_response(res, 400) == %{"error" => "confirm"}
      assert Accounts.get_user(u.id)
    end

    test "a JSON list instead of an object: refused cleanly", %{u: u} do
      assert json_response(signed_in(u) |> json_post("/api/account/delete", ["DELETE"]), 400) ==
               %{"error" => "confirm"}

      assert json_response(signed_in(u) |> json_post("/api/car", [1, 2]), 400)["error"] ==
               "invalid"
    end

    test "JSON with a charset, any case: accepted", %{u: u} do
      res =
        signed_in(u)
        |> put_req_header("content-type", "Application/JSON; charset=utf-8")
        |> post("/api/car", Jason.encode!(%{color: "Gray", make: "Honda", model: "Civic"}))

      assert json_response(res, 200)["car"]["make"] == "Honda"
    end

    test "over 64 KB: 413, never parsed" do
      big = Jason.encode!(%{"pad" => String.duplicate("x", 64_100)})

      assert_raise Plug.Parsers.RequestTooLargeError, fn ->
        json_post(build_conn(), "/api/logout", big)
      end
    end

    test "just under 64 KB: read" do
      ok = Jason.encode!(%{"pad" => String.duplicate("x", 63_000)})
      assert json_post(build_conn(), "/api/logout", ok).status == 200
    end

    test "a form or a file upload is never read" do
      res =
        build_conn()
        |> put_req_header("content-type", "application/x-www-form-urlencoded")
        |> post("/api/logout", "a=1")

      assert res.status == 200
      assert res.body_params == %{} or is_struct(res.body_params)
    end
  end
end
