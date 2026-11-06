defmodule HoodrideWeb.RobotsTest do
  @moduledoc """
  robots.txt (owner, 2026-10-30): crawl the pages, don't start sign-ins.
  Google: robots.txt manages crawler traffic (not privacy or security), and
  must not block what a page needs to render — the front page asks
  /api/state before it shows the sign-in screen, and Google's sign-in
  review reads the front page and the privacy policy. Google matches rules
  as case-sensitive path prefixes (query strings included).
  """
  use HoodrideWeb.ConnCase, async: true

  @robots File.read!("priv/static/robots.txt")

  # the Disallow rules for every crawler (User-agent: *), as Google reads them
  defp disallowed do
    @robots
    |> String.split("\n")
    |> Enum.map(&(&1 |> String.split("#") |> hd() |> String.trim()))
    |> Enum.reject(&(&1 == ""))
    |> Enum.chunk_while(
      nil,
      fn line, group ->
        case String.split(line, ":", parts: 2) do
          [k, v] when k in ["User-agent", "user-agent"] ->
            {:cont, group, {String.trim(v), []}}

          [k, v] when k in ["Disallow", "disallow"] and group != nil ->
            {agent, rules} = group
            {:cont, {agent, [String.trim(v) | rules]}}

          _ ->
            {:cont, group}
        end
      end,
      fn group -> {:cont, group, nil} end
    )
    |> Enum.reject(&is_nil/1)
    |> Enum.filter(fn {agent, _} -> agent == "*" end)
    |> Enum.flat_map(fn {_, rules} -> rules end)
    |> Enum.reject(&(&1 == ""))
  end

  defp blocked?(path), do: Enum.any?(disallowed(), &String.starts_with?(path, &1))

  test "the rules: every crawler, only the sign-in routes" do
    assert disallowed() == ["/auth/"]
  end

  test "the pages, the privacy policy and what the front page needs stay open" do
    for path <- ~w(/ /privacy /api/state /api/me /index.html /?demo=1),
        do: refute(blocked?(path), path)
  end

  test "starting a sign-in is off limits" do
    for path <- ~w(/auth/google /auth/google?refresh=1 /auth/google/callback?code=x),
        do: assert(blocked?(path), path)
  end

  test "served at the top level: 200, plain text, no sign-in needed", %{conn: conn} do
    conn = get(conn, "/robots.txt")
    assert conn.status == 200
    assert [type] = get_resp_header(conn, "content-type")
    assert type =~ "text/plain"
    # the rules exactly as written, then the server's sitemap line
    assert String.starts_with?(conn.resp_body, String.trim_trailing(@robots) <> "\n")
  end
end
