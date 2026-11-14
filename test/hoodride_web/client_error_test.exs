defmodule HoodrideWeb.ClientErrorTest do
  @moduledoc """
  POST /api/client-error (owner, 2026-11-10): the app's error reports —
  WHAT broke, never who. Logged as ONE line; everything checked again here
  (a modified app could send anything): known fields only, sizes capped,
  the message scrubbed with the app's rules (links, emails, 4+ digit
  numbers); junk refused.
  """
  use HoodrideWeb.ConnCase, async: false
  import ExUnit.CaptureLog

  @good %{
    "kind" => "TypeError",
    "message" => "x is undefined",
    "at" => ["app.js:1:65786", "nearby.js:12:40"],
    "where" => "chat",
    "build" => "b123abc",
    "browser" => "Chrome/Android"
  }

  # each report from its own address (a few per address a minute: the
  # per-address test sets its own) — so the other tests' reports all count
  defp post_report(%{remote_ip: {127, 0, 0, 1}} = conn, body),
    do: post(%{conn | remote_ip: fresh_ip()}, "/api/client-error", body)

  defp post_report(conn, body), do: post(conn, "/api/client-error", body)

  defp fresh_ip do
    n = System.unique_integer([:positive])
    {10, rem(div(n, 65_536), 256), rem(div(n, 256), 256), rem(n, 256)}
  end

  test "a report: 204, ONE log line with what broke", %{conn: conn} do
    log = capture_log(fn -> assert post_report(conn, @good).status == 204 end)
    lines = log |> String.split("\n") |> Enum.filter(&(&1 =~ "client error:"))
    assert [line] = lines
    assert line =~ "client error: TypeError: x is undefined"
    assert line =~ "at app.js:1:65786 nearby.js:12:40"
    assert line =~ "where=chat build=b123abc browser=Chrome/Android"
  end

  test "the message scrubbed again here: links, emails, long numbers never logged", %{conn: conn} do
    raw =
      "fail https://x.example/u?id=6620271782574400 bob@mail.com 40.7154,-74.0086 555-123-4567"

    log = capture_log(fn -> post_report(conn, Map.put(@good, "message", raw)) end)
    refute log =~ "6620271782574400"
    refute log =~ "bob@mail.com"
    refute log =~ "40.7154"
    refute log =~ "x.example"
    refute log =~ "4567"
    assert log =~ "<link>"
    assert log =~ "<email>"
  end

  # a flood (one address, or many — IPv6 gives one host thousands) must
  # never drown the real errors or fill the disk: at most N logged a minute
  # IN ALL, then ONE line saying the rest were dropped; the phone can't tell
  test "a flood: at most the cap logged a minute, then one 'dropped' line — every reply the same 204",
       %{conn: conn} do
    Hoodride.TestHelpers.scrub_live_state()
    Application.put_env(:hoodride, :client_error_cap, 3)
    on_exit(fn -> Application.delete_env(:hoodride, :client_error_cap) end)

    log =
      capture_log(fn ->
        for i <- 1..6,
            do: assert(post_report(conn, Map.put(@good, "message", "flood #{i}x")).status == 204)
      end)

    assert length(Regex.scan(~r/client error: TypeError: flood/, log)) == 3
    assert length(Regex.scan(~r/client error: over 3 a minute/, log)) == 1
  end

  # (crash review 2026-11-14) one address used to be able to fill the whole
  # minute's cap — every real report from everyone else dropped. Now each
  # address gets a few (the app itself sends at most 5 a minute), so the
  # rest of the cap stays for everyone else
  test "one address can't fill the minute: past its few, others still get through", %{conn: conn} do
    Hoodride.TestHelpers.scrub_live_state()
    flood = %{conn | remote_ip: {203, 0, 113, 7}}
    other = %{build_conn() | remote_ip: {198, 51, 100, 9}}

    log =
      capture_log(fn ->
        for i <- 1..100,
            do: assert(post_report(flood, Map.put(@good, "message", "flood #{i}x")).status == 204)

        assert post_report(other, Map.put(@good, "message", "real one")).status == 204
      end)

    flooded = length(Regex.scan(~r/client error: TypeError: flood/, log))
    assert flooded >= 5 and flooded <= 10, "logged from the one address: #{flooded}"
    assert log =~ "client error: TypeError: real one"
  end

  # (mutation kills, 2026-11-10)
  test "kind, build, browser: one plain word each — a space or a newline can't forge a line", %{
    conn: conn
  } do
    log =
      capture_log(fn ->
        post_report(conn, %{@good | "kind" => "a b", "browser" => "x
client error: forged", "build" => "b 1"})
      end)

    lines = log |> String.split("
") |> Enum.filter(&(&1 =~ "client error:"))
    assert length(lines) == 1
    assert hd(lines) =~ "client error: Error: x is undefined"
    assert hd(lines) =~ "build=? browser=?"
  end

  test "the message: exactly 200 characters at most; places: the first 3 well-formed", %{
    conn: conn
  } do
    assert String.length(HoodrideWeb.ClientErrorController.scrub(String.duplicate("z", 1000))) ==
             200

    four = ["a.js:1:1", "b.js:2:2", "c.js:3:3", "d.js:4:4"]
    log = capture_log(fn -> post_report(conn, %{@good | "at" => four}) end)
    assert log =~ "at a.js:1:1 b.js:2:2 c.js:3:3 where="
  end

  test "every screen word passes through; links in any case are scrubbed", %{conn: conn} do
    for w <- ~w(map chat ride settings search start sync other) do
      log =
        capture_log(fn -> post_report(conn, %{@good | "where" => w, "message" => "m #{w}"}) end)

      assert log =~ "where=#{w} ", w
    end

    assert HoodrideWeb.ClientErrorController.scrub("see HTTPS://X.EXAMPLE/a") == "see <link>"
  end

  test "any number of 2+ digits scrubbed here too (small account ids); a lone digit stays" do
    assert HoodrideWeb.ClientErrorController.scrub(
             "HTTP 503 after 2 tries; reading '42'; 123 Main St"
           ) ==
             "HTTP <n> after 2 tries; reading '<n>'; <n> Main St"
  end

  test "only known, well-formed fields: anything else dropped or refused", %{conn: conn} do
    # unknown fields never logged
    log = capture_log(fn -> post_report(conn, Map.put(@good, "user_email", "bob@mail.com")) end)
    refute log =~ "bob@mail.com"
    refute log =~ "user_email"

    # a place that isn't file:line:col, a where outside the list, a long
    # build: cleaned, never echoed
    weird = %{
      @good
      | "at" => ["https://evil.example/x.js:1:2", "app.js:3:4", "<script>"],
        "where" => "elsewhere",
        "build" => String.duplicate("b", 300)
    }

    log = capture_log(fn -> assert post_report(conn, weird).status == 204 end)
    refute log =~ "evil.example"
    refute log =~ "<script>"
    assert log =~ "where=other"
    refute log =~ String.duplicate("b", 100)

    # no kind or no message: junk
    assert post_report(conn, Map.delete(@good, "message")).status == 400
    assert post_report(conn, %{"anything" => 1}).status == 400
  end

  test "a long message is cut; a newline can't forge a second log line", %{conn: conn} do
    log =
      capture_log(fn ->
        post_report(
          conn,
          Map.put(
            @good,
            "message",
            "first\nclient error: forged\n" <> String.duplicate("z", 1000)
          )
        )
      end)

    # (the forged words may sit INSIDE the one line, as text: never a line of
    # their own)
    lines = log |> String.split("
") |> Enum.filter(&(&1 =~ "client error:"))
    assert length(lines) == 1

    assert Enum.all?(
             lines,
             &(&1 =~ "[warning] client error: TypeError: first client error: forged")
           )

    refute log =~ String.duplicate("z", 300)
  end

  alias HoodrideWeb.ClientErrorController, as: C

  # (abuse review, 2026-11-12) the scrubbing ran on the WHOLE message — up
  # to 64 KB, no sign-in needed — and only then cut it to 200: the email
  # pattern on 64 KB of letters takes seconds of CPU per report
  test "a 64 KB message is scrubbed in milliseconds, not seconds" do
    for junk <- [
          String.duplicate("a", 64_000),
          String.duplicate("a.", 32_000),
          String.duplicate("1 ", 32_000),
          String.duplicate("ab-", 21_000) <> "@"
        ] do
      {us, out} = :timer.tc(fn -> C.scrub(junk) end)
      assert String.length(out) <= 200
      assert us < 100_000, "#{div(us, 1000)} ms for #{byte_size(junk)} bytes"
    end
  end

  # cutting BEFORE scrubbing could split an email or a link: the half left
  # no longer looks like one and would be logged as text — and a long link
  # before it shrinks to <link>, pulling what was far down into the 200 kept
  test "a cut never leaves half an email or link in the line" do
    long_link = "https://x.example/" <> String.duplicate("p", 960)

    for tail <- ["someone.private@mail.example.com", "https://y.example/secret/path"] do
      out = C.scrub("boom " <> long_link <> " then " <> tail <> " more words")
      refute out =~ "someone", out
      refute out =~ "private", out
      refute out =~ "secret", out
      assert out =~ "boom <link> then"
    end
  end

  test "nothing changes for an ordinary message" do
    assert C.scrub("TypeError: x is undefined, mail a@b.example, call 555 1234") ==
             "TypeError: x is undefined, mail <email>, call <n>"
  end
end
