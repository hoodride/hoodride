defmodule HoodrideWeb.Lang do
  @moduledoc """
  Which language to show someone (owner, 2026-11-04), among those switched
  on (Hoodride.I18n.on/0):

  1. the one they picked — the `hoodride_lang` cookie the language switch
     sets (stage 2). Nothing is stored unless they pick (privacy policy:
     the device list);
  2. else their browser's: Accept-Language, best first — an exact tag, or
     its language alone (`es-MX` → `es`);
  3. else English.

  An answer that depends on these says so (`vary/1`): no cache may hand
  one person's language to another.
  """

  import Plug.Conn

  @cookie "hoodride_lang"

  @doc "The cookie a picked language is kept in."
  def cookie, do: @cookie

  @doc "The language for this request."
  def pick(conn) do
    on = Hoodride.I18n.on()
    conn = fetch_cookies(conn)

    case conn.req_cookies[@cookie] do
      picked when is_binary(picked) ->
        match(picked, on) || from_browser(conn, on)

      _ ->
        from_browser(conn, on)
    end
  end

  defp from_browser(conn, on) do
    conn
    |> get_req_header("accept-language")
    |> Enum.join(",")
    |> preferred()
    |> Enum.find_value("en", &match(&1, on))
  end

  @doc """
  The language among `on` for one asked-for tag, or nil: the exact tag
  (any case), else its language alone ("es-MX" → "es") — never another
  region of it ("en-US" doesn't pick the made-up "en-XA").
  """
  def match(tag, on) do
    tag = String.downcase(tag)
    exact = Enum.find(on, &(String.downcase(&1) == tag))
    exact || Enum.find(on, &(&1 == tag |> String.split("-") |> hd()))
  end

  @doc """
  An Accept-Language header's tags, most wanted first (RFC 9110 §12.5.4:
  `q=0` means "not this"; equal weights keep their order).
  """
  def preferred(header) do
    header
    |> String.split(",", trim: true)
    |> Enum.with_index()
    |> Enum.flat_map(fn {part, i} ->
      case String.split(part, ";") |> Enum.map(&String.trim/1) do
        [tag | params] when tag != "" and tag != "*" ->
          if Regex.match?(~r/^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/, tag),
            do: [{tag, weight(params), i}],
            else: []

        _ ->
          []
      end
    end)
    |> Enum.reject(fn {_, q, _} -> q <= 0 end)
    |> Enum.sort_by(fn {_, q, i} -> {-q, i} end)
    |> Enum.map(fn {tag, _, _} -> tag end)
  end

  defp weight(params) do
    Enum.find_value(params, 1.0, fn p ->
      case Regex.run(~r/^q=(0(\.\d{0,3})?|1(\.0{0,3})?)$/i, p) do
        [_, q | _] -> q |> Float.parse() |> elem(0)
        _ -> nil
      end
    end)
  end

  @doc "Marks an answer as depending on the language."
  def vary(conn), do: put_resp_header(conn, "vary", "Accept-Language, Cookie")
end
