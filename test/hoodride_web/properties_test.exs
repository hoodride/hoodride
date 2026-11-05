defmodule HoodrideWeb.PropertiesTest do
  @moduledoc """
  Property tests (owner, 2026-11-05): instead of a few hand-written cases,
  hundreds of random ones against a RULE that must always hold — where the
  server takes input from outside in endless variety (StreamData; failing
  cases shrink to the smallest one; reproducible from the test seed).
  Each rule is a real one, not just "doesn't crash" (weakest to strongest:
  no crash → invariant → idempotent → oracle — Trail of Bits' ranking).
  """
  use HoodrideWeb.ConnCase, async: false
  use ExUnitProperties

  alias Hoodride.{I18n, RateBudget}
  alias HoodrideWeb.{Lang, PageController}

  # ----- the browser's language header -----

  # tags people's browsers really send, odd ones included, in any case
  defp tag_gen do
    StreamData.one_of([
      StreamData.member_of(I18n.on()),
      StreamData.member_of(~w(en-US en-GB es-MX es-419 pt-PT pt fr-CA de-CH zh zh-TW zh-HK zh-CN
                              zh-Hant-TW no nn tl iw in sr x-klingon i-default EN JA Pt-bR)),
      StreamData.string(:alphanumeric, min_length: 1, max_length: 9),
      StreamData.string(:printable, max_length: 12)
    ])
  end

  defp weight_gen do
    StreamData.one_of([
      StreamData.constant(""),
      StreamData.map(StreamData.integer(0..1000), &";q=#{&1 / 1000}"),
      StreamData.member_of([
        ";q=0",
        ";q=1",
        ";q=1.000",
        ";Q=0.5",
        ";q=abc",
        ";q=2",
        ";q=-1",
        ";",
        "; q=0.7"
      ])
    ])
  end

  defp header_gen do
    StreamData.one_of([
      StreamData.map(
        StreamData.list_of(
          StreamData.tuple({tag_gen(), weight_gen(), StreamData.member_of(["", " ", "  "])}),
          max_length: 8
        ),
        fn parts -> Enum.map_join(parts, ",", fn {t, w, sp} -> sp <> t <> w end) end
      ),
      StreamData.binary(max_length: 40)
    ])
  end

  property "any language header: never a crash; the tags kept are well formed, none refused (q=0)" do
    check all(header <- header_gen()) do
      tags = Lang.preferred(header)
      assert is_list(tags)
      for t <- tags, do: assert(t =~ ~r/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/)
    end
  end

  # the strongest kind of property: an oracle. Any list of well-formed tags
  # with weights → exactly what RFC 9110 says: q=0 ("not this") dropped,
  # the highest weight first, equal weights in their order. (The property
  # above only checked the shape — a deliberate break, q=0 kept, got
  # through it: owner, 2026-11-05)
  property "well-formed tags with weights: exactly the RFC's order — q=0 dropped, highest first, ties in order" do
    check all(
            parts <-
              StreamData.list_of(
                StreamData.tuple({
                  StreamData.member_of(I18n.on() ++ ~w(en-US es-MX zh-TW pt-PT no tl x-klingon)),
                  # q=0 often (browsers send it on purpose; 1 in 1001 by chance
                  # never came up), 1000 (=1.0) too, and no weight at all
                  StreamData.one_of([
                    StreamData.constant(0),
                    StreamData.integer(1..1000),
                    StreamData.constant(1000),
                    StreamData.constant(nil)
                  ])
                }),
                max_length: 8
              )
          ) do
      header =
        Enum.map_join(parts, ", ", fn
          {tag, nil} -> tag
          {tag, q} -> "#{tag};q=#{q / 1000}"
        end)

      expected =
        parts
        |> Enum.with_index()
        |> Enum.map(fn {{tag, q}, i} -> {tag, if(q == nil, do: 1000, else: q), i} end)
        |> Enum.reject(fn {_, q, _} -> q == 0 end)
        |> Enum.sort_by(fn {_, q, i} -> {-q, i} end)
        |> Enum.map(fn {tag, _, _} -> tag end)

      assert Lang.preferred(header) == expected, header
    end
  end

  property "any header, any cookie: the language picked is always one switched on" do
    check all(
            header <- header_gen(),
            cookie <- StreamData.one_of([StreamData.constant(nil), tag_gen()])
          ) do
      conn = build_conn() |> put_req_header("accept-language", header)
      conn = if cookie, do: put_req_cookie(conn, Lang.cookie(), cookie), else: conn
      assert Lang.pick(conn) in I18n.on()
    end
  end

  property "the phone's first choice, switched on, at full weight: that language (whatever follows)" do
    check all(
            lang <- StreamData.member_of(I18n.on()),
            rest <-
              StreamData.list_of(
                StreamData.tuple({tag_gen(), StreamData.integer(0..999)}),
                max_length: 5
              )
          ) do
      tail = Enum.map_join(rest, "", fn {t, q} -> ", #{t};q=#{q / 1000}" end)
      conn = build_conn() |> put_req_header("accept-language", lang <> tail)
      assert Lang.pick(conn) == lang
    end
  end

  property "a language chosen (cookie), in any capitals: that language, whatever the phone says" do
    check all(
            lang <- StreamData.member_of(I18n.on()),
            caps <- StreamData.list_of(StreamData.boolean(), length: String.length(lang)),
            header <- header_gen()
          ) do
      cased =
        lang
        |> String.graphemes()
        |> Enum.zip(caps)
        |> Enum.map_join(fn {g, up} -> if up, do: String.upcase(g), else: String.downcase(g) end)

      conn =
        build_conn()
        |> put_req_header("accept-language", header)
        |> put_req_cookie(Lang.cookie(), cased)

      assert Lang.pick(conn) == lang
    end
  end

  # ----- the language in the address -----

  defp segment_gen do
    StreamData.one_of([
      StreamData.member_of(I18n.on()),
      StreamData.map(StreamData.member_of(I18n.on()), &String.upcase/1),
      StreamData.map(StreamData.member_of(I18n.on()), &String.downcase/1),
      StreamData.member_of(~w(en EN xx zz .. . index.html sw api auth privacy terms)),
      StreamData.string(:alphanumeric, min_length: 1, max_length: 10),
      StreamData.string(:printable, min_length: 1, max_length: 10)
    ])
  end

  # (each case loads pages: a deep run — PROP_RUNS=2000 — takes minutes)
  @tag timeout: :infinity
  property "any address: a page, a forward or not found — never an error; a forward lands in one step, the query kept" do
    check all(
            seg <- segment_gen(),
            rest <- StreamData.member_of(["", "/privacy", "/terms", "/nope"]),
            slash <- StreamData.boolean(),
            query <-
              StreamData.one_of([
                StreamData.constant(""),
                StreamData.string(:alphanumeric, min_length: 1, max_length: 8)
              ])
          ) do
      path =
        "/" <> URI.encode(seg, &URI.char_unreserved?/1) <> rest <> if(slash, do: "/", else: "")

      url = if query == "", do: path, else: path <> "?x=" <> query
      conn = build_conn() |> get(url)

      assert conn.status in [200, 301, 302, 404], "#{url} → #{conn.status}"

      if conn.status in [301, 302] do
        [to] = get_resp_header(conn, "location")

        assert String.starts_with?(to, "/") and not String.starts_with?(to, "//"),
               "#{url} → #{to}"

        if query != "",
          do: assert(String.ends_with?(to, "?x=" <> query), "#{url} → #{to}: the query lost")

        assert build_conn() |> get(to) |> Map.get(:status) == 200, "#{url} → #{to}: not a page"
      end
    end
  end

  # ----- "type DELETE to confirm" -----

  property "the typed word: the same once or twice; never an accent left" do
    check all(word <- StreamData.string(:utf8, max_length: 20)) do
      once = I18n.typed_word(word)
      assert I18n.typed_word(once) == once
      refute once =~ ~r/\p{M}/u
    end
  end

  property "each language's word to confirm, typed in any capitals, with spaces around: accepted" do
    words = I18n.delete_words()

    check all(
            word <- StreamData.member_of(words),
            caps <-
              StreamData.list_of(StreamData.boolean(), length: length(String.graphemes(word))),
            pad <- StreamData.member_of(["", " ", "  ", "\t"])
          ) do
      typed =
        word
        |> String.graphemes()
        |> Enum.zip(caps)
        |> Enum.map_join(fn {g, up} -> if up, do: String.upcase(g), else: g end)

      assert I18n.typed_word(pad <> typed <> pad) in words,
             "#{inspect(typed)} refused (from #{inspect(word)})"
    end
  end

  # ----- the pages' links in their language -----

  defp html_gen do
    StreamData.map(
      StreamData.list_of(
        StreamData.member_of([
          ~s(<a href="/">home</a>),
          ~s(<a href="/privacy">p</a>),
          ~s(<a href="/terms">t</a>),
          ~s(<a href="/privacy?lang=en">english</a>),
          ~s(<a href="/terms?lang=en">english</a>),
          ~s(<a href="/privacy.css">x</a>),
          ~s(<a href="/terms/x">x</a>),
          ~s(<a href="mailto:contact@hoodride.app">m</a>),
          "text ",
          "\n"
        ]),
        max_length: 15
      ),
      &Enum.join/1
    )
  end

  property "a page's links in its language: no bare home/terms/privacy left, the English-original links untouched, twice = once" do
    check all(
            html <- html_gen(),
            lang <- StreamData.member_of(I18n.addressed())
          ) do
      out = PageController.localize_links(html, lang)

      refute out =~ ~s(href="/") or out =~ ~s(href="/privacy") or out =~ ~s(href="/terms"),
             "a bare link left: #{out}"

      for kept <- [
            ~s(href="/privacy?lang=en"),
            ~s(href="/terms?lang=en"),
            ~s(href="/privacy.css"),
            ~s(href="/terms/x")
          ] do
        assert length(String.split(out, kept)) == length(String.split(html, kept)),
               "#{kept} changed"
      end

      assert PageController.localize_links(out, lang) == out
      assert PageController.localize_links(html, "en") == html
    end
  end

  # ----- the rate budgets (stateful: random sequences against two rules) -----

  # (every window of every sequence checked: a deep run takes minutes)
  @tag timeout: :infinity
  property "rate budgets: never more than the allowance in any window; the wait it gives is exact; refusals spend nothing" do
    check all(
            per_minute <- StreamData.integer(1..600),
            burst <- StreamData.integer(0..40),
            steps <-
              StreamData.list_of(StreamData.float(min: 0.0, max: 3.0),
                min_length: 1,
                max_length: 60
              )
          ) do
      who = System.unique_integer([:positive])
      interval = 60_000 / per_minute

      {passed, _} =
        Enum.reduce(steps, {[], 1_000_000}, fn gap, {passed, now} ->
          now = now + round(gap * interval)
          wait = RateBudget.wait_ms(who, :property, per_minute, burst, now)

          case RateBudget.spend(who, :property, per_minute, burst, now) do
            {:ok, _} ->
              assert wait == 0, "allowed although the wait said #{wait} ms"
              {[now | passed], now}

            {:deny, _} ->
              assert wait > 0, "refused although the wait said 0"
              # a refusal spends nothing: the same wait after it
              assert RateBudget.wait_ms(who, :property, per_minute, burst, now) == wait
              # and after exactly that wait, one is allowed
              later = now + wait
              assert {:ok, _} = RateBudget.spend(who, :property, per_minute, burst, later)
              {[later | passed], later}
          end
        end)

      # any window [a, b]: at most burst + 1 at once, plus one per interval
      times = Enum.reverse(passed)

      for {a, i} <- Enum.with_index(times), {b, j} <- Enum.with_index(times), j >= i do
        count = j - i + 1
        allowed = burst + 1 + floor((b - a) / interval + 1.0e-9)

        assert count <= allowed,
               "#{count} passed in #{b - a} ms (allowed #{allowed}; #{per_minute}/min, burst #{burst})"
      end
    end
  end
end
