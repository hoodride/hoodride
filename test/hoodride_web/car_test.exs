defmodule HoodrideWeb.CarTest do
  @moduledoc """
  "Your car" (ARCHITECTURE.md "Your car"): a driver's color, make and model
  — what a rider looks for on the street ("check that the make and color
  match"). No plate (owner's choice). Set in Settings, required by the app
  before going online, shown ONLY to riders: on a car's card (the name
  lookup, `reveal`), in a ride and in a waiting request. Other drivers never
  get it, and a rider's own car (if they once drove) never travels.
  """
  use HoodrideWeb.ConnCase, async: false

  alias Hoodride.{Accounts, Geo, Requests, Rides, TestClient}

  @cell "882a1072c7fffff"

  setup do
    Hoodride.TestHelpers.scrub_live_state()
    :ok
  end

  defp user(key) do
    {:ok, u} = Accounts.upsert_oauth_user(%{provider: "dev", provider_id: key, name: key})
    u
  end

  defp signed_in(conn, u) do
    init_test_session(conn, Hoodride.TestHelpers.session_for(u.id))
  end

  defp set_car(conn, u, car), do: post(signed_in(conn, u), "/api/car", car)

  @civic %{"color" => "Gray", "make" => "Honda", "model" => "Civic"}

  describe "setting it" do
    test "saved, and read back — with the label riders see", %{conn: conn} do
      u = user("car-a")

      assert %{"car" => %{"label" => "Gray Honda Civic"}} =
               json_response(set_car(conn, u, @civic), 200)

      assert json_response(get(signed_in(build_conn(), u), "/api/car"), 200)["car"] ==
               %{
                 "color" => "Gray",
                 "make" => "Honda",
                 "model" => "Civic",
                 "label" => "Gray Honda Civic"
               }
    end

    # "Other" is no color to look for: "Other Honda Civic" read as nonsense
    # (owner, 2026-10-30) — riders see just the make and model; the form
    # keeps "Other" picked
    test "color Other: riders see just the make and model", %{conn: conn} do
      u = user("car-other")
      other = %{@civic | "color" => "Other"}

      assert %{"car" => %{"color" => "Other", "label" => "Honda Civic"}} =
               json_response(set_car(conn, u, other), 200)

      assert Accounts.car_label(Accounts.get_user(u.id)) == "Honda Civic"
    end

    test "nothing set yet: null", %{conn: conn} do
      assert json_response(get(signed_in(conn, user("car-b")), "/api/car"), 200) == %{
               "car" => nil
             }
    end

    test "tidied: spaces trimmed and squeezed", %{conn: conn} do
      u = user("car-c")
      car = %{"color" => "White", "make" => "  Toyota ", "model" => " Corolla   Cross "}

      assert %{"car" => %{"label" => "White Toyota Corolla Cross"}} =
               json_response(set_car(conn, u, car), 200)
    end

    test "refused, and nothing changes: an unknown color, a blank or too long field, hidden characters",
         %{conn: conn} do
      u = user("car-d")
      json_response(set_car(conn, u, @civic), 200)

      for {bad, field} <- [
            {%{@civic | "color" => "Sparkly"}, "color"},
            {%{@civic | "make" => "   "}, "make"},
            {%{@civic | "model" => String.duplicate("x", 25)}, "model"},
            # zero-width space; right-to-left override (text that reads backwards)
            {%{@civic | "make" => "Hon\u200Bda"}, "make"},
            {%{@civic | "model" => "Civ\u202Eic"}, "model"},
            {%{@civic | "model" => "Civic\n"}, "model"},
            {Map.delete(@civic, "make"), "make"},
            {%{@civic | "make" => 7}, "make"}
          ] do
        res = set_car(build_conn(), u, bad)
        assert %{"error" => "invalid", "fields" => fields} = json_response(res, 400), inspect(bad)
        assert field in fields, inspect(bad)
      end

      assert json_response(get(signed_in(build_conn(), u), "/api/car"), 200)["car"]["label"] ==
               "Gray Honda Civic"
    end

    test "24 characters is fine; letters from any language too", %{conn: conn} do
      u = user("car-e")
      car = %{"color" => "Blue", "make" => "Škoda", "model" => String.duplicate("é", 24)}
      assert json_response(set_car(conn, u, car), 200)
    end

    test "signed out: 401", %{conn: conn} do
      assert json_response(post(conn, "/api/car", @civic), 401)
      assert json_response(get(build_conn(), "/api/car"), 401)
    end

    test "the database can't answer: 503 (try again), never a half save", %{conn: conn} do
      u = user("car-f")
      # signed in BEFORE the database goes away (signing in writes it)
      again = signed_in(build_conn(), u)
      conn = signed_in(conn, u)
      Hoodride.Repo.query!("ALTER TABLE users RENAME TO users_away")
      assert json_response(post(conn, "/api/car", @civic), 503) == %{"error" => "busy"}

      assert json_response(get(again, "/api/car"), 503) == %{
               "error" => "busy"
             }
    end
  end

  describe "who sees it" do
    defp drive(u), do: Geo.driver_update(%{id: u.id, name: u.name, photo: nil}, @cell, nil)

    defp with_car(u) do
      {:ok, _} = Accounts.set_car(u.id, @civic)
      u
    end

    test "a rider tapping the car: name AND car (one tap, and a batch)", %{conn: _} do
      d = with_car(user("car-d1"))
      drive(d)
      rider = TestClient.start(:car_rider, user("car-r1"))
      {:ok, _} = TestClient.request(rider, "world", "sync", %{"geo" => [@cell]})

      assert {:ok, %{car: "Gray Honda Civic", name: "car-d1"}} =
               TestClient.request(rider, "world", "reveal", %{"id" => d.id})

      assert {:ok, %{users: [%{car: "Gray Honda Civic"}]}} =
               TestClient.request(rider, "world", "reveal", %{"ids" => [d.id]})

      # and its parts, for the reader's language (HoodCar.describe —
      # "Honda Civic gris"; languages 2b)
      assert {:ok, %{car_parts: %{color: "Gray", make: "Honda", model: "Civic"}}} =
               TestClient.request(rider, "world", "reveal", %{"id" => d.id})
    end

    # the whole path for "Other": the card a rider taps, and the ride
    test "color Other: the rider sees \"Honda Civic\" on the card and in the ride", %{conn: _} do
      d = user("car-d5")
      {:ok, _} = Accounts.set_car(d.id, %{@civic | "color" => "Other"})
      drive(d)
      r = user("car-r5")
      rider = TestClient.start(:car_rider_other, r)
      {:ok, _} = TestClient.request(rider, "world", "sync", %{"geo" => [@cell]})

      assert {:ok, %{car: "Honda Civic"}} =
               TestClient.request(rider, "world", "reveal", %{"id" => d.id})

      assert {:ok, %{users: [%{car: "Honda Civic"}]}} =
               TestClient.request(rider, "world", "reveal", %{"ids" => [d.id]})

      rt = "user:#{r.id}"
      HoodrideWeb.Endpoint.subscribe(rt)
      {:ok, _} = Rides.start_ride(r.id, d.id)

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^rt,
        event: "ride_started",
        payload: %{peer: %{car: "Honda Civic"}}
      }
    end

    test "a driver tapping a ✋: no car — even if that rider once set one", %{conn: _} do
      hand = with_car(user("car-h1"))
      Geo.hand_up(hand.id, @cell, nil)
      d = user("car-d2")
      drive(d)
      driver = TestClient.start(:car_driver, d)
      {:ok, _} = TestClient.request(driver, "world", "sync", %{"geo" => [@cell]})

      assert {:ok, revealed} = TestClient.request(driver, "world", "reveal", %{"id" => hand.id})
      refute Map.has_key?(revealed, :car)

      assert {:ok, %{users: [batch]}} =
               TestClient.request(driver, "world", "reveal", %{"ids" => [hand.id]})

      refute Map.has_key?(batch, :car)
    end

    test "a ride: the rider gets the driver's car; the driver gets none of the rider's", %{
      conn: conn
    } do
      d = with_car(user("car-d3"))
      r = with_car(user("car-r3"))
      HoodrideWeb.Endpoint.subscribe("user:#{r.id}")
      HoodrideWeb.Endpoint.subscribe("user:#{d.id}")
      {:ok, _} = Rides.start_ride(r.id, d.id)

      rt = "user:#{r.id}"
      dt = "user:#{d.id}"

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^rt,
        event: "ride_started",
        payload: %{peer: to_rider}
      }

      assert to_rider.car == "Gray Honda Civic"

      assert_receive %Phoenix.Socket.Broadcast{
        topic: ^dt,
        event: "ride_started",
        payload: %{peer: to_driver}
      }

      refute Map.has_key?(to_driver, :car)

      # …and after a reload
      assert json_response(get(signed_in(conn, r), "/api/state"), 200)["ride"]["peer"]["car"] ==
               "Gray Honda Civic"

      refute Map.has_key?(
               json_response(get(signed_in(build_conn(), d), "/api/state"), 200)["ride"]["peer"],
               "car"
             )
    end

    test "a waiting request: the rider's app knows which car it asked for", %{conn: conn} do
      d = with_car(user("car-d4"))
      drive(d)
      r = user("car-r4")
      :ok = Requests.create(%{id: r.id, name: r.name, photo: nil}, d.id)

      assert json_response(get(signed_in(conn, r), "/api/state"), 200)["open_request"]["driver"][
               "car"
             ] ==
               "Gray Honda Civic"

      # the driver's waiting list: riders, no car
      [waiting] =
        json_response(get(signed_in(build_conn(), d), "/api/state"), 200)["pending_requests"]

      refute Map.has_key?(waiting["rider"], "car")
    end

    test "no car set: nothing (the app shows \"Driver\")", %{conn: _} do
      d = user("car-d5")
      drive(d)
      rider = TestClient.start(:car_rider5, user("car-r5"))
      {:ok, _} = TestClient.request(rider, "world", "sync", %{"geo" => [@cell]})
      assert {:ok, %{car: nil}} = TestClient.request(rider, "world", "reveal", %{"id" => d.id})
    end

    test "deleting the account deletes the car with it", %{conn: _} do
      d = with_car(user("car-d6"))
      :ok = Hoodride.AccountDeletion.delete(d.id)
      assert Hoodride.Repo.query!("SELECT count(*) FROM users WHERE id = ?", [d.id]).rows == [[0]]
    end
  end

  test "the privacy policy says riders see your car" do
    html = File.read!("priv/static/privacy.html")
    assert html =~ ~r/your car's color, make and model/i
    assert html =~ "Never your license plate"
    assert html =~ "Other drivers don't see it"
  end

  # a US app: US spelling wherever people read it (owner, 2026-10-30) —
  # "color", "license", never "colour"/"licence"
  test "US spelling: the car form, its error, the privacy page" do
    html = File.read!("priv/static/index.html")
    app = File.read!("priv/static/app.js")
    assert html =~ ~s(<label class="car-field" data-t>Color\n)

    assert app =~
             ~s[const CAR_FIELD_NAMES = { color: () => t("color"), make: () => t("make"), model: () => t("model") };]

    for file <- ~w(index.html app.js car.js privacy.html styles.css) do
      text = File.read!(Path.join("priv/static", file))
      refute text =~ ~r/colour|licence/i, "#{file}: British spelling"
    end
  end
end
