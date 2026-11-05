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

  @doc "Every message in our scripts: `{:ok, [message]}` or `{:error, [problem]}`."
  # Reviewed (2026-11-04): the files are our own priv/static/*.js, listed by
  # sources/1 at build time (`mix hoodride.i18n.extract`, the tests) —
  # never a name from a request; this never runs in the app.
  # sobelow_skip ["Traversal.FileModule"]
  def scan_all(files \\ sources()) do
    {found, problems} =
      Enum.reduce(files, {[], []}, fn file, {found, problems} ->
        case scan_js(File.read!(file), file) do
          {:ok, ms} -> {found ++ ms, problems}
          {:error, ps} -> {found, problems ++ ps}
        end
      end)

    if problems == [], do: {:ok, found}, else: {:error, problems}
  end

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
