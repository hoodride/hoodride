defmodule Hoodride.I18n.Extract do
  @moduledoc """
  Every message the app shows, collected from its code into gettext's
  standard list (`priv/gettext/default.pot`) — what a translator works from
  (owner, 2026-11-04: Hood Ride in more languages).

  The app's words live in its JavaScript, each wrapped as `t("…")`,
  `tc("context", "…")` or `tn("singular", "plural", n)` (HoodI18n,
  priv/static/i18n.js), with the English as the key. This reads those
  files as code: a `t("…")` inside a comment, a string, a template's text
  or a regex doesn't count — one inside a template's `${…}` does. It
  REFUSES a call it can't read (`t(name)`, `t(\`…\`)`, `t("a" + b)`): a
  message built at run time could never be translated, so it must be
  plain text where it's written.
  """

  alias Expo.Message
  alias Expo.Messages

  # code the app ships that isn't ours (THIRD-PARTY.md), and the helper
  # itself (its comments show calls as examples)
  @not_ours ~w(maplibre-gl.js h3-js.umd.js phoenix.min.js i18n.js)

  @doc "Our scripts in `dir`, sorted (relative paths)."
  def sources(dir \\ "priv/static") do
    dir
    |> Path.join("*.js")
    |> Path.wildcard()
    |> Enum.reject(&(Path.basename(&1) in @not_ours))
    |> Enum.sort()
  end

  @doc """
  The messages in one script: `{:ok, [message]}` or `{:error, [problem]}`.
  A message is `%{context: nil | s, msgid: s, plural: nil | s, file: f, line: n}`.
  """
  def scan_js(source, file) do
    # calls are FOUND in the code alone; their arguments are READ from the
    # source (mask/1 keeps every byte where it was)
    code = mask(source)

    {found, problems} =
      Regex.scan(~r/(?<![\w$.])(?:HoodI18n\.)?(tc|tn|t)\(/, code, return: :index)
      |> Enum.reduce({[], []}, fn [{start, len}, {fs, fl}], {found, problems} ->
        fun = binary_part(code, fs, fl)
        line = line_of(source, start)

        case args(source, start + len, arity(fun)) do
          {:ok, strings} ->
            {[message(fun, strings, file, line) | found], problems}

          :error ->
            {found,
             [
               "#{file}:#{line}: #{fun}(…) needs plain \"text\" — a message must be written out to be translated"
               | problems
             ]}
        end
      end)

    if problems == [], do: {:ok, Enum.reverse(found)}, else: {:error, Enum.reverse(problems)}
  end

  defp arity("t"), do: 1
  defp arity("tc"), do: 2
  defp arity("tn"), do: 2

  defp message("t", [msgid], file, line),
    do: %{context: nil, msgid: msgid, plural: nil, file: file, line: line}

  defp message("tc", [ctx, msgid], file, line),
    do: %{context: ctx, msgid: msgid, plural: nil, file: file, line: line}

  defp message("tn", [one, many], file, line),
    do: %{context: nil, msgid: one, plural: many, file: file, line: line}

  # the first `n` arguments, each a "double-quoted" string literal, followed
  # by "," or — after the last text — ")" too (so `t("a" + b)` is refused)
  defp args(src, at, n) do
    Enum.reduce_while(1..n, {:ok, [], at}, fn i, {:ok, acc, pos} ->
      pos = skip_space(src, pos)

      with {:ok, s, after_s} <- string_at(src, pos),
           after_s = skip_space(src, after_s),
           next when next in [",", ")"] <- char_at(src, after_s),
           true <- i == n or next == "," do
        {:cont, {:ok, [s | acc], after_s + 1}}
      else
        _ -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, acc, _} -> {:ok, Enum.reverse(acc)}
      :error -> :error
    end
  end

  defp char_at(src, pos) when pos < byte_size(src), do: binary_part(src, pos, 1)
  defp char_at(_, _), do: nil

  defp skip_space(src, pos) do
    case src do
      <<_::binary-size(^pos), c, _::binary>> when c in ~c" \t\r\n" -> skip_space(src, pos + 1)
      _ -> pos
    end
  end

  # a "…" literal starting at `pos`, unescaped as JavaScript does
  defp string_at(src, pos) do
    case src do
      <<_::binary-size(^pos), ?", rest::binary>> -> read_string(rest, pos + 1, [])
      _ -> :error
    end
  end

  defp read_string(<<?", _::binary>>, pos, acc),
    do: {:ok, acc |> Enum.reverse() |> IO.iodata_to_binary(), pos + 1}

  defp read_string(<<?\n, _::binary>>, _pos, _acc), do: :error

  defp read_string(<<?\\, ?u, ?{, rest::binary>>, pos, acc) do
    case Integer.parse(rest, 16) do
      {cp, "}" <> rest2} ->
        read_string(rest2, pos + 3 + byte_size(rest) - byte_size(rest2), [<<cp::utf8>> | acc])

      _ ->
        :error
    end
  end

  defp read_string(<<?\\, ?u, hex::binary-size(4), rest::binary>>, pos, acc) do
    case Integer.parse(hex, 16) do
      {cp, ""} -> read_string(rest, pos + 6, [<<cp::utf8>> | acc])
      _ -> :error
    end
  end

  defp read_string(<<?\\, c, rest::binary>>, pos, acc) do
    ch =
      case c do
        ?n -> "\n"
        ?t -> "\t"
        ?r -> "\r"
        other -> <<other>>
      end

    read_string(rest, pos + 2, [ch | acc])
  end

  defp read_string(<<c::utf8, rest::binary>>, pos, acc),
    do: read_string(rest, pos + byte_size(<<c::utf8>>), [<<c::utf8>> | acc])

  defp read_string(_, _, _), do: :error

  defp line_of(src, at), do: 1 + (src |> binary_part(0, at) |> :binary.matches("\n") |> length())

  @doc """
  The source with everything that isn't code blanked: comments, the
  insides of strings, template text and regular expressions — byte for
  byte (a character of N bytes becomes N spaces; newlines stay), so every
  position and line number is the source's own. The code inside a
  template's `${…}` stays code.
  """
  def mask(source), do: source |> code([], [], nil) |> Enum.reverse() |> IO.iodata_to_binary()

  # code/4: `stack` is [] at the top level, or [depth | outer] inside a
  # template's ${…} (depth: the { } opened within it)
  defp code(<<>>, acc, _stack, _prev), do: acc

  defp code(<<"//", rest::binary>>, acc, stack, _prev) do
    {comment, rest} = to_line_end(rest)
    code(rest, [blank("//" <> comment) | acc], stack, nil)
  end

  defp code(<<"/*", rest::binary>>, acc, stack, prev) do
    case :binary.split(rest, "*/") do
      [comment, rest] -> code(rest, [blank("/*" <> comment <> "*/") | acc], stack, prev)
      [comment] -> [blank("/*" <> comment) | acc]
    end
  end

  defp code(<<q, rest::binary>>, acc, stack, _prev) when q in [?", ?'] do
    {inside, rest, closed?} = quoted(rest, q, [])
    # the closing quote only if the source has one (an unclosed quote ends
    # at the line's end: adding one would shift every byte after it)
    acc = [inside | [<<q>> | acc]]
    code(rest, if(closed?, do: [<<q>> | acc], else: acc), stack, q)
  end

  defp code(<<?`, rest::binary>>, acc, stack, _prev), do: template(rest, ["`" | acc], stack)

  defp code(<<?{, rest::binary>>, acc, [depth | outer], _prev),
    do: code(rest, ["{" | acc], [depth + 1 | outer], ?{)

  defp code(<<?}, rest::binary>>, acc, [0 | outer], _prev), do: template(rest, ["}" | acc], outer)

  defp code(<<?}, rest::binary>>, acc, [depth | outer], _prev),
    do: code(rest, ["}" | acc], [depth - 1 | outer], ?})

  defp code(<<?/, rest::binary>>, acc, stack, prev) do
    if regex_start?(prev) do
      {inside, rest} = regex(rest, [], false)
      code(rest, ["/" | [inside | ["/" | acc]]], stack, ?/)
    else
      code(rest, ["/" | acc], stack, ?/)
    end
  end

  defp code(<<c::utf8, rest::binary>>, acc, stack, prev) do
    code(rest, [<<c::utf8>> | acc], stack, if(c in ~c" \t\r\n", do: prev, else: c))
  end

  # a template's text: blanked; ${ starts code; ` ends it
  defp template(<<>>, acc, _stack), do: acc

  defp template(<<?\\, c::utf8, rest::binary>>, acc, stack),
    do: template(rest, [blank(<<?\\, c::utf8>>) | acc], stack)

  defp template(<<?`, rest::binary>>, acc, stack), do: code(rest, ["`" | acc], stack, ?`)
  defp template(<<"${", rest::binary>>, acc, stack), do: code(rest, ["${" | acc], [0 | stack], ?{)

  defp template(<<c::utf8, rest::binary>>, acc, stack),
    do: template(rest, [blank(<<c::utf8>>) | acc], stack)

  defp regex_start?(prev), do: prev == nil or prev in ~c"(,=:[!&|?{};+-*%<>~^"

  defp to_line_end(s) do
    case :binary.split(s, "\n") do
      [line, rest] -> {line, "\n" <> rest}
      [line] -> {line, ""}
    end
  end

  # each character becomes as many spaces as it has bytes; newlines stay
  defp blank(text),
    do:
      for(<<c::utf8 <- text>>,
        into: "",
        do: if(c == ?\n, do: "\n", else: :binary.copy(" ", byte_size(<<c::utf8>>)))
      )

  # a string's inside (blanked), what follows it, and whether it closed
  defp quoted(<<?\\, c::utf8, rest::binary>>, q, acc),
    do: quoted(rest, q, [blank(<<?\\, c::utf8>>) | acc])

  defp quoted(<<c, rest::binary>>, q, acc) when c == q, do: {Enum.reverse(acc), rest, true}
  defp quoted(<<?\n, _::binary>> = rest, _q, acc), do: {Enum.reverse(acc), rest, false}
  defp quoted(<<c::utf8, rest::binary>>, q, acc), do: quoted(rest, q, [blank(<<c::utf8>>) | acc])
  defp quoted(<<>>, _q, acc), do: {Enum.reverse(acc), <<>>, false}

  # a /regex/'s inside (blanked), its [classes] included (a `/` inside one
  # doesn't end it), and what follows its closing slash
  defp regex(<<?\\, c::utf8, rest::binary>>, acc, cls),
    do: regex(rest, [blank(<<?\\, c::utf8>>) | acc], cls)

  defp regex(<<?[, rest::binary>>, acc, _cls), do: regex(rest, [" " | acc], true)
  defp regex(<<?], rest::binary>>, acc, true), do: regex(rest, [" " | acc], false)
  defp regex(<<?/, rest::binary>>, acc, false), do: {Enum.reverse(acc), rest}
  defp regex(<<?\n, _::binary>> = rest, acc, _cls), do: {Enum.reverse(acc), rest}

  defp regex(<<c::utf8, rest::binary>>, acc, cls),
    do: regex(rest, [blank(<<c::utf8>>) | acc], cls)

  defp regex(<<>>, acc, _cls), do: {Enum.reverse(acc), <<>>}

  @doc "Our pages with marked words (`data-t`, `data-t-attr` — HoodI18n.translatePage)."
  def pages(dir \\ "priv/static"), do: Enum.map(~w(index.html notfound.html), &Path.join(dir, &1))

  @doc "Our server code (its own words: `Hoodride.I18n.t(lang, \"…\")`)."
  # (not the language code itself: its notes show calls as examples)
  def server_sources(dir \\ "lib") do
    dir
    |> Path.join("**/*.ex")
    |> Path.wildcard()
    |> Enum.reject(&(&1 =~ ~r{/hoodride/i18n(\.ex|/)}))
    |> Enum.sort()
  end

  @doc """
  The server's own messages in one Elixir file: each
  `Hoodride.I18n.t(lang, "…")` (or `I18n.t(…)`), the text plain — no
  `\#{…}`, it would be built at run time. `{:ok, [message]}` or `{:error, [problem]}`.
  """
  def scan_ex(source, file) do
    {found, problems} =
      Regex.scan(~r/(?<![\w.])(?:Hoodride\.)?I18n\.t\(\s*[\w.]+\s*,\s*/, source, return: :index)
      |> Enum.reduce({[], []}, fn [{start, len}], {found, problems} ->
        line = line_of(source, start)
        rest = binary_part(source, start + len, byte_size(source) - start - len)

        case Regex.run(~r/^"((?:[^"\\#]|\\.|#(?!\{))*)"\s*\)/, rest) do
          [_, text] ->
            id = Regex.replace(~r/\\(.)/, text, "\\1")
            {[%{context: nil, msgid: id, plural: nil, file: file, line: line} | found], problems}

          nil ->
            {found,
             [
               "#{file}:#{line}: I18n.t(…) needs plain \"text\" — a message must be written out to be translated"
               | problems
             ]}
        end
      end)

    if problems == [], do: {:ok, Enum.reverse(found)}, else: {:error, Enum.reverse(problems)}
  end

  # elements with no closing tag
  @void ~w(area base br col embed hr img input link meta source track wbr)

  @doc """
  The marked words in one page — by translatePage's rules (i18n.js):
  `data-t` (its value, if any, the context) takes the element's words, a
  child marked `data-t-slot="name"` standing in as `{name}`; other child
  elements only before or after the words. `data-t-attr="a b"`: those
  attributes' values. `{:ok, [message]}` or `{:error, [problem]}`.
  """
  def scan_html(source, file) do
    # comments out, every byte kept (positions and lines stay true)
    html = Regex.replace(~r/<!--.*?-->/s, source, &blank/1)

    {found, problems} =
      Regex.scan(~r/<([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/, html, return: :index)
      |> Enum.reduce({[], []}, fn [{start, len}, name_at, attrs_at], acc ->
        attrs = attributes(part(html, attrs_at))
        line = line_of(source, start)
        name = String.downcase(part(html, name_at))

        acc
        |> marked_words(attrs, html, name, start + len, file, line)
        |> marked_attrs(attrs, file, line)
      end)

    if problems == [], do: {:ok, Enum.reverse(found)}, else: {:error, Enum.reverse(problems)}
  end

  defp part(s, {at, len}), do: binary_part(s, at, len)

  defp attributes(text) do
    for [_, k | v] <- Regex.scan(~r/([\w-]+)(?:="([^"]*)")?/, text), into: %{} do
      {k, unescape(List.first(v) || "")}
    end
  end

  defp marked_words({found, problems}, %{"data-t" => ctx}, html, name, from, file, line) do
    case children(html, name, from) do
      {:ok, kids} ->
        case words(kids) do
          {:ok, ""} ->
            {found, ["#{file}:#{line}: data-t on an element with no words" | problems]}

          {:ok, id} ->
            m = %{
              context: if(ctx == "", do: nil, else: ctx),
              msgid: id,
              plural: nil,
              file: file,
              line: line
            }

            {[m | found], problems}

          :error ->
            {found,
             [
               "#{file}:#{line}: an element between the words — only a data-t-slot may stand there"
               | problems
             ]}
        end

      :error ->
        {found, ["#{file}:#{line}: <#{name} data-t> isn't closed" | problems]}
    end
  end

  defp marked_words(acc, _attrs, _html, _name, _from, _file, _line), do: acc

  defp marked_attrs({found, problems}, %{"data-t-attr" => names} = attrs, file, line) do
    Enum.reduce(String.split(names), {found, problems}, fn a, {found, problems} ->
      case attrs do
        %{^a => v} when v != "" ->
          {[%{context: nil, msgid: v, plural: nil, file: file, line: line} | found], problems}

        _ ->
          {found, ["#{file}:#{line}: data-t-attr names #{a}, which isn't there" | problems]}
      end
    end)
  end

  defp marked_attrs(acc, _attrs, _file, _line), do: acc

  # the element's direct children up to its closing tag: {:text, s} |
  # {:slot, name} | :element
  defp children(html, name, from), do: children(html, name, from, 0, [], [])

  defp children(html, name, pos, depth, kids, text) do
    case Regex.run(~r/<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(\/?)>/, html,
           return: :index,
           offset: pos
         ) do
      nil ->
        :error

      [{at, len}, close_at, tag_at, attrs_at, self_at] ->
        between = binary_part(html, pos, at - pos)
        text = if depth == 0, do: [between | text], else: text
        tag = String.downcase(part(html, tag_at))
        closing? = part(html, close_at) == "/"
        empty? = part(html, self_at) == "/" or tag in @void
        next = at + len

        cond do
          closing? and depth == 0 and tag == name ->
            {:ok, Enum.reverse(flush(text, kids))}

          closing? ->
            children(html, name, next, depth - 1, kids, text)

          depth == 0 ->
            kid =
              case attributes(part(html, attrs_at)) do
                %{"data-t-slot" => slot} -> {:slot, slot}
                _ -> :element
              end

            kids = [kid | flush(text, kids)]
            children(html, name, next, if(empty?, do: 0, else: 1), kids, [])

          true ->
            children(html, name, next, if(empty?, do: depth, else: depth + 1), kids, text)
        end
    end
  end

  defp flush([], kids), do: kids

  defp flush(text, kids),
    do: [{:text, text |> Enum.reverse() |> IO.iodata_to_binary() |> unescape()} | kids]

  # the words: text and slots, other elements only at either end
  defp words(kids) do
    words? = fn
      {:text, s} -> tidy(s) != ""
      {:slot, _} -> true
      :element -> false
    end

    middle =
      kids
      |> Enum.drop_while(&(not words?.(&1)))
      |> Enum.reverse()
      |> Enum.drop_while(&(not words?.(&1)))
      |> Enum.reverse()

    if :element in middle do
      :error
    else
      {:ok,
       middle
       |> Enum.map_join(fn
         {:text, s} -> s
         {:slot, name} -> "{#{name}}"
       end)
       |> tidy()}
    end
  end

  # as the browser's text: runs of HTML white space are one space (a
  # no-break space stays)
  defp tidy(s), do: s |> String.replace(~r/[ \t\n\r\f]+/, " ") |> String.trim(" ")

  defp unescape(s) do
    Regex.replace(~r/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/, s, fn whole, ref ->
      case ref do
        "#x" <> hex -> <<String.to_integer(hex, 16)::utf8>>
        "#" <> dec -> <<String.to_integer(dec)::utf8>>
        "nbsp" -> " "
        "amp" -> "&"
        "lt" -> "<"
        "gt" -> ">"
        "quot" -> "\""
        "apos" -> "'"
        _ -> whole
      end
    end)
  end

  @doc "Every message in our scripts and pages: `{:ok, [message]}` or `{:error, [problem]}`."
  # Reviewed (2026-11-04): the files are our own priv/static/*.js, listed by
  # sources/1 at build time (`mix hoodride.i18n.extract`, the tests) —
  # never a name from a request; this never runs in the app.
  # sobelow_skip ["Traversal.FileModule"]
  def scan_all(files \\ sources() ++ pages() ++ server_sources()) do
    {found, problems} =
      Enum.reduce(files, {[], []}, fn file, {found, problems} ->
        scan =
          case Path.extname(file) do
            ".html" -> &scan_html/2
            ".ex" -> &scan_ex/2
            _ -> &scan_js/2
          end

        case scan.(File.read!(file), file) do
          {:ok, ms} -> {found ++ ms, problems}
          {:error, ps} -> {found, problems ++ ps}
        end
      end)

    if problems == [], do: {:ok, found}, else: {:error, problems}
  end

  @doc """
  A language's translations (`po`, Expo.Messages) brought in line with the
  list (`pot`): its header kept; each message the list has, with the
  translation it had (same message, same kind — plain or plural), else
  blank; messages no longer in the list dropped. What gettext's
  `msgmerge` does, without fuzzy guesses (a near-miss translation shown as
  right is worse than English).
  """
  def merge(%Messages{} = pot, %Messages{} = po) do
    had = Map.new(po.messages, &{key(&1), &1})

    messages =
      for m <- pot.messages do
        case had[key(m)] do
          %{__struct__: same} = old when same == m.__struct__ -> %{m | msgstr: old.msgstr}
          _ -> m
        end
      end

    %{po | messages: messages}
  end

  # (a long text may be read back in pieces: compared whole)
  defp key(%Message.Plural{} = m), do: {text(m.msgctxt), text(m.msgid), text(m.msgid_plural)}
  defp key(%Message.Singular{} = m), do: {text(m.msgctxt), text(m.msgid)}

  defp text(nil), do: nil
  defp text(iodata), do: IO.iodata_to_binary(iodata)

  @doc "A language's .po text."
  def po(%Messages{} = po), do: po |> Expo.PO.compose() |> IO.iodata_to_binary()

  @doc """
  The list file's contents: one entry per message (context + English;
  for a plural, its singular and plural), sorted, with the files it's in
  (no line numbers — they'd change with every edit nearby).
  """
  def pot(found) do
    entries =
      found
      |> Enum.group_by(&{&1.context, &1.msgid, &1.plural})
      |> Enum.sort_by(fn {{ctx, id, pl}, _} -> {id, ctx || "", pl || ""} end)
      |> Enum.map(fn {{ctx, id, pl}, ms} ->
        refs = ms |> Enum.map(& &1.file) |> Enum.uniq() |> Enum.sort()

        if pl,
          do: %Message.Plural{
            msgid: [id],
            msgid_plural: [pl],
            msgctxt: ctx && [ctx],
            msgstr: %{0 => [""], 1 => [""]},
            references: [refs]
          },
          else: %Message.Singular{msgid: [id], msgctxt: ctx && [ctx], references: [refs]}
      end)

    %Messages{
      top_comments: [
        [
          " The app's messages, in English (the keys). Made by `mix hoodride.i18n.extract`; don't edit by hand."
        ]
      ],
      headers: ["Content-Type: text/plain; charset=UTF-8\n"],
      messages: entries
    }
    |> Expo.PO.compose()
    |> IO.iodata_to_binary()
  end
end
