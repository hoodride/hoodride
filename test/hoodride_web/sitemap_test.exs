defmodule HoodrideWeb.SitemapTest do
  @moduledoc """
  /sitemap.xml (owner, 2026-11-05): every page in every language, so search
  engines find them all. It must match the language list exactly — a
  language added or removed shows up here, or the gate fails — and list
  only real pages under their own (canonical) address. Google's rules:
  full addresses, UTF-8, canonical pages only; robots.txt names it by its
  full address.
  """
  use HoodrideWeb.ConnCase, async: true

  # the pages need no database: the page walks (20 s) leave the test
  # database's one connection to the tests that do
  @moduletag db: false

  alias Hoodride.I18n

  defp sitemap(conn) do
    conn = get(conn, "/sitemap.xml")
    assert conn.status == 200
    conn
  end

  defp locs(body), do: Regex.scan(~r{<loc>([^<]*)</loc>}, body) |> Enum.map(fn [_, l] -> l end)

  defp paths(body) do
    base = HoodrideWeb.Endpoint.url()

    for loc <- locs(body) do
      assert String.starts_with?(loc, base <> "/"), "not a full address: #{loc}"
      String.replace_prefix(loc, base, "")
    end
  end

  defp alternates(html) do
    Regex.scan(~r{<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">}, html)
    |> Enum.reject(fn [_, tag, _] -> tag == "x-default" end)
    |> Enum.map(fn [_, _, href] ->
      String.replace_prefix(href, HoodrideWeb.Endpoint.url(), "")
    end)
  end

  test "served as XML in the sitemaps.org format, and well formed", %{conn: conn} do
    conn = sitemap(conn)
    assert [type] = get_resp_header(conn, "content-type")
    assert type =~ "application/xml"
    assert String.starts_with?(conn.resp_body, ~s(<?xml version="1.0" encoding="UTF-8"?>))

    # every line in its place: the header, the list, one <url> per line
    # holding an address with nothing XML would misread (& < > " ')
    [header, open | rest] = String.split(conn.resp_body, "\n")
    assert header == ~s(<?xml version="1.0" encoding="UTF-8"?>)
    assert open == ~s(<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">)
    assert ["</urlset>", ""] = Enum.take(rest, -2)
    urls = Enum.drop(rest, -2)
    assert urls != []

    for line <- urls,
        do: assert(line =~ ~r{\A  <url><loc>https?://[^<>&"' ]+</loc></url>\z}, line)
  end

  test "exactly the language list: three pages for every language, nothing else",
       %{conn: conn} do
    # written out here, not made by the code under test
    expected =
      ["/", "/privacy", "/terms"] ++
        Enum.flat_map(I18n.addressed(), &["/#{&1}", "/#{&1}/privacy", "/#{&1}/terms"])

    got = paths(sitemap(conn).resp_body)

    assert Enum.sort(got) == Enum.sort(expected)
    assert length(got) == length(Enum.uniq(got)), "a page listed twice"
    assert length(got) == 3 * length(I18n.on() -- [I18n.pseudo()])

    # every language switched on is in it (the test setup: all of them)
    for lang <- I18n.on() -- ["en", I18n.pseudo()], do: assert("/#{lang}" in got, lang)
    refute Enum.any?(got, &(&1 == "/en" or String.starts_with?(&1, "/en/"))), "/en forwards to /"

    refute Enum.any?(got, &String.contains?(&1, I18n.pseudo())),
           "the pseudo-language is for testing"
  end

  test "the same languages the pages themselves name (their alternates)", %{conn: conn} do
    got = paths(sitemap(conn).resp_body)

    for page <- ["/", "/privacy", "/terms"] do
      named = alternates(get(build_conn(), page).resp_body)
      assert named != []
      listed = Enum.filter(got, &(&1 in named))
      assert Enum.sort(listed) == Enum.sort(named), page
    end

    assert length(got) == 3 * length(alternates(get(build_conn(), "/").resp_body))
  end

  test "every address is a real page whose own address is the one listed", %{conn: conn} do
    base = HoodrideWeb.Endpoint.url()

    for path <- paths(sitemap(conn).resp_body) do
      page = get(build_conn(), path)
      assert page.status == 200, "#{path}: #{page.status}"
      assert page.resp_body =~ ~s(<link rel="canonical" href="#{base}#{path}">), path
    end
  end

  # (Sobelow's XSS.SendResp is skipped on `sitemap`: our own addresses only.
  # Whatever ever reaches it, the five characters XML would misread come
  # out escaped — sitemaps.org's table; &#39; is XML's own form of ')
  test "an address with & < > \" ' comes out escaped, nothing left raw" do
    xml = HoodrideWeb.PageController.sitemap_xml(~s(https://x.test/a&b<c>d"e'f), ["en"])
    [loc | _] = locs(xml)
    # (the English home page: the site's address and "/")
    assert loc == "https://x.test/a&amp;b&lt;c&gt;d&quot;e&#39;f/"
    refute xml =~ ~s(<c>)
    refute xml =~ ~s(d"e)
    refute xml =~ ~s(e'f)
  end

  # The site as a search engine walks it (Google: it follows <a href> links;
  # robots.txt says where not to go): from the home page, every link to
  # our own pages, page after page. Each page counted by its own
  # (canonical) address — /privacy?lang=en is /privacy. A broken link fails.
  defp crawl do
    blocked =
      File.read!("priv/static/robots.txt")
      |> String.split("\n")
      |> Enum.flat_map(fn line ->
        case Regex.run(~r{^Disallow:\s*(\S+)}, line) do
          [_, rule] -> [rule]
          nil -> []
        end
      end)

    crawl(["/"], MapSet.new(["/"]), MapSet.new(), blocked)
  end

  defp crawl([], _queued, pages, _blocked), do: pages

  # `queued`: every address ever put in line, so each page is fetched once
  defp crawl([path | queue], queued, pages, blocked) do
    base = HoodrideWeb.Endpoint.url()
    conn = get(build_conn(), path)

    {next, pages} =
      case conn.status do
        200 ->
          html = conn.resp_body

          [_, canonical] =
            Regex.run(~r{<link rel="canonical" href="([^"]+)">}, html) ||
              flunk("#{path}: no canonical address")

          links =
            Regex.scan(~r{<a\s[^>]*href="([^"]*)"}, html)
            |> Enum.map(fn [_, href] -> String.replace_prefix(href, base, "") end)
            |> Enum.filter(&(String.starts_with?(&1, "/") and not String.starts_with?(&1, "//")))
            |> Enum.map(&(&1 |> String.split("#") |> hd()))
            |> Enum.reject(fn link -> Enum.any?(blocked, &String.starts_with?(link, &1)) end)

          {links, MapSet.put(pages, String.replace_prefix(canonical, base, ""))}

        status when status in 301..308 ->
          [to] = get_resp_header(conn, "location")
          {[String.replace_prefix(to, base, "")], pages}

        status ->
          flunk("a link to #{path} is broken: #{status}")
      end

    new = next |> Enum.uniq() |> Enum.reject(&(&1 in queued))
    crawl(queue ++ new, Enum.into(new, queued), pages, blocked)
  end

  test "following the links finds exactly the sitemap: nothing missing, nothing unlinked",
       %{conn: conn} do
    listed = MapSet.new(paths(sitemap(conn).resp_body))
    found = crawl()

    assert MapSet.difference(found, listed) |> Enum.sort() == [],
           "linked pages missing from the sitemap"

    assert MapSet.difference(listed, found) |> Enum.sort() == [],
           "sitemap pages no link reaches"
  end

  test "no dates, priority or change frequency (Google ignores or distrusts them)",
       %{conn: conn} do
    body = sitemap(conn).resp_body
    for tag <- ~w(lastmod priority changefreq), do: refute(body =~ "<#{tag}>", tag)
  end

  test "robots.txt names it by its full address, the site's own", %{conn: conn} do
    lines =
      get(conn, "/robots.txt").resp_body
      |> String.split("\n")
      |> Enum.filter(&String.starts_with?(&1, "Sitemap:"))

    assert lines == ["Sitemap: #{HoodrideWeb.Endpoint.url()}/sitemap.xml"]

    # made from the site's address, wherever it's hosted — never written
    # into the file (owner, 2026-11-05: nothing hard-coded)
    assert HoodrideWeb.PageController.robots_txt("Disallow: /x/\n", "https://ride.example") ==
             "Disallow: /x/\n\nSitemap: https://ride.example/sitemap.xml\n"

    refute File.read!("priv/static/robots.txt") =~ ~r/^Sitemap:/m
  end
end
