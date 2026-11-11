defmodule Hoodride.Chat do
  require Logger

  @moduledoc """
  Ephemeral conversations. A conversation exists once a message is sent, or
  once a ride starts between the two (open/2) — never just because a chat
  window was opened. It lives in ETS while BOTH people are around: the
  sweeper deletes it once EITHER has been offline past grace, unless the
  two share a ride (owner's rule, 2026-10-23 — before, it took both).
  Deleting it tells both people ("chat_closed").

  Delivery model: all messages route through the recipient's user channel
  ("user:<id>"), so there are no per-conversation topics to join and no
  missed messages for conversations you didn't know you had yet.
  """

  @conversations :chat_conversations
  @messages :chat_messages
  # per-user index: {{user_id, pair_key}}, two rows per conversation. The
  # ordered_set keeps a user's rows adjacent, so "my conversations" is a
  # bound-prefix range read — O(log n + k) — not a copy of every chat.
  #
  # Write order makes the harmful drift impossible: a send writes the
  # conversation THEN its index rows; a delete removes the index rows THEN
  # the conversation. Any interleaving can leave an index row without its
  # conversation (harmless: every hit is confirmed), never a conversation
  # without its index rows (it would vanish from a reload). The sweeper
  # removes the harmless kind and re-adds any missing ones.
  @by_user :chat_by_user

  # THE SENDER'S BLOCK (ARCHITECTURE.md "Distances"): someone not driving
  # shares their rough area — a ~170 m block, never a position — with whoever
  # they message. {{pair_key, sender_id}, spot, at_ms}: the LATEST per sender
  # per conversation, sent only with a message (never streamed), deleted
  # with the conversation; a stray from a send racing a delete goes at the
  # sweeper's repair pass (heal_index).
  @spots :chat_spots
  # {{sender, cid}, receipt, at}: a message the app may send again (its reply
  # lost) — the same id gets the same receipt, never a second delivery
  @sent_ids :chat_sent_ids
  @sent_id_ttl 600

  # retained history per conversation — delivery is never capped, only what
  # the server remembers; old messages fall off the back (ephemeral by nature)
  @max_history 50

  def init_tables do
    Hoodride.ETS.new(@conversations, [:named_table, :public, :set])
    Hoodride.ETS.new(@messages, [:named_table, :public, :duplicate_bag])
    Hoodride.ETS.new(@by_user, [:named_table, :public, :ordered_set])
    Hoodride.ETS.new(@spots, [:named_table, :public, :set])
    Hoodride.ETS.new(@sent_ids, [:named_table, :public, :set])
    :ok
  end

  def pair_key(a, b), do: {min(a, b), max(a, b)}

  def exists?(a, b), do: :ets.member(@conversations, pair_key(a, b))

  @doc """
  The receipt of a message this sender already sent with this client id (a
  retry after its reply was lost), or nil. Ids live 10 minutes.
  """
  def sent_receipt(_from_id, nil), do: nil

  def sent_receipt(from_id, cid) do
    case :ets.lookup(@sent_ids, {from_id, cid}) do
      [{_, receipt, at}] -> if System.system_time(:second) - at <= @sent_id_ttl, do: receipt
      [] -> nil
    end
  end

  @doc "Remember a sent message's client id (see sent_receipt/2)."
  def remember_sent(_from_id, nil, _receipt), do: :ok

  def remember_sent(from_id, cid, receipt),
    do: :ets.insert(@sent_ids, {{from_id, cid}, receipt, System.system_time(:second)})

  @doc "Forget client ids past their 10 minutes (the sweeper)."
  def sweep_sent_ids do
    cutoff = System.system_time(:second) - @sent_id_ttl
    :ets.select_delete(@sent_ids, [{{:_, :_, :"$1"}, [{:<, :"$1", cutoff}], [true]}])
    :ok
  end

  @doc """
  Send `text` to `to_id`. `spot`: the sender's block, or nil — the CALLER
  decides whether it may be shared (HoodrideWeb.UserChannel: never an
  online driver's, only a well-formed one).
  """
  def send_message(from, to_id, text, spot \\ nil) do
    key = pair_key(from.id, to_id)
    now = System.system_time(:second)
    id = System.unique_integer([:positive, :monotonic])

    :ets.insert(@conversations, {key, now})
    index(key)
    :ets.insert(@messages, {key, id, from.id, text, now})
    trim_history(key)
    if spot, do: :ets.insert(@spots, {{key, from.id}, spot, System.system_time(:millisecond)})

    HoodrideWeb.Endpoint.broadcast("user:#{to_id}", "msg", %{
      id: id,
      from: %{id: from.id, name: from.name, photo: from.photo},
      text: text,
      ts: now,
      spot: spot
    })

    {:ok, %{id: id, ts: now}}
  end

  @doc """
  A ride's conversation, with no message in it. Called at ride start, so
  the ride's own chat is a relationship from the first second: the first
  message is never a cold contact, and a silent ride stays reachable after
  it ends (while both are around, like any chat). Same write order as a
  send: the conversation, THEN its index rows.
  """
  def open(a, b) do
    key = pair_key(a, b)
    :ets.insert(@conversations, {key, System.system_time(:second)})
    index(key)
    :ok
  end

  def conversations_for(user_id) do
    for {{^user_id, key}} <- :ets.match_object(@by_user, {{user_id, :_}}),
        [{^key, last}] <- [:ets.lookup(@conversations, key)] do
      {a, b} = key
      peer_id = if a == user_id, do: b, else: a

      messages =
        @messages
        |> :ets.lookup(key)
        |> Enum.map(fn {_k, id, sender, text, ts} ->
          %{id: id, from: sender, text: text, ts: ts}
        end)
        |> Enum.sort_by(& &1.id)

      %{
        peer_id: peer_id,
        last_activity: last,
        messages: messages,
        peer_spot: spot_of(key, peer_id)
      }
    end
  end

  @doc """
  Light reload (owner, 2026-11-08): a conversation from conversations_for/1
  as a SUMMARY for the chat list — no texts. `last`: the newest message's
  id, time, whether it's mine, and a preview (preview/1); nil when there's
  none yet (a ride's chat). `theirs`: the partner's messages' ids and
  times, which is what unread counts. Both from the newest @max_history —
  the same messages conversation_messages/2 gives (a send between its
  insert and its trim can leave one more for a moment).
  """
  def summary(%{messages: messages} = c, user_id) do
    kept = Enum.take(messages, -@max_history)

    last =
      case List.last(kept) do
        nil -> nil
        m -> %{id: m.id, ts: m.ts, mine: m.from == user_id, preview: preview(m.text)}
      end

    c
    |> Map.delete(:messages)
    |> Map.merge(%{
      last: last,
      theirs: for(m <- kept, m.from == c.peer_id, do: %{id: m.id, ts: m.ts})
    })
  end

  @preview_chars 100
  @preview_bytes 400

  @doc """
  The start of a message for the chat list: whole characters (graphemes —
  never half an emoji), as many as fit in #{@preview_chars} characters AND
  #{@preview_bytes} bytes (one "character" can be dozens of bytes). A first
  character bigger than that on its own: "".
  """
  def preview(text), do: preview(text, 0, [])

  defp preview(_rest, @preview_chars, acc), do: acc |> Enum.reverse() |> IO.iodata_to_binary()

  defp preview(rest, n, acc) do
    case String.next_grapheme(rest) do
      nil ->
        acc |> Enum.reverse() |> IO.iodata_to_binary()

      {g, more} ->
        if IO.iodata_length(acc) + byte_size(g) > @preview_bytes,
          do: acc |> Enum.reverse() |> IO.iodata_to_binary(),
          else: preview(more, n + 1, [g | acc])
    end
  end

  @doc """
  One conversation's messages, for its opening (`GET /api/chat`): `peer` is
  the request's text, compared with the caller's own conversations' partner
  ids as text — "012", "12abc" or a list never match. The newest
  @max_history, oldest first, today's shape. `:none` for anything that
  isn't the caller's conversation now (the index row and the conversation
  itself are both checked: an index row can outlive its conversation for a
  moment, see @by_user). No copy of any other conversation.
  """
  def conversation_messages(user_id, peer) when is_binary(peer) do
    found =
      for {{^user_id, {a, b} = key}} <- :ets.match_object(@by_user, {{user_id, :_}}),
          Integer.to_string(if a == user_id, do: b, else: a) == peer,
          do: key

    case found do
      [key] ->
        if :ets.member(@conversations, key), do: {:ok, messages_of(key)}, else: :none

      _ ->
        :none
    end
  end

  def conversation_messages(_user_id, _peer), do: :none

  defp messages_of(key) do
    @messages
    |> :ets.lookup(key)
    |> Enum.map(fn {_k, id, sender, text, ts} -> %{id: id, from: sender, text: text, ts: ts} end)
    |> Enum.sort_by(& &1.id)
    |> Enum.take(-@max_history)
  end

  # the peer's latest block in this conversation, with its age — counted on
  # the SERVER's clock, so a phone's wrong clock can't skew it
  defp spot_of(key, sender) do
    case :ets.lookup(@spots, {key, sender}) do
      [{_, spot, at}] -> %{spot: spot, age_ms: max(System.system_time(:millisecond) - at, 0)}
      [] -> nil
    end
  end

  defp index({a, b} = key) do
    :ets.insert(@by_user, [{{a, key}}, {{b, key}}])
  end

  defp trim_history(key) do
    messages = :ets.lookup(@messages, key)
    excess = length(messages) - @max_history

    if excess > 0 do
      messages
      |> Enum.sort_by(fn {_k, id, _s, _t, _ts} -> id end)
      |> Enum.take(excess)
      |> Enum.each(fn obj -> :ets.delete_object(@messages, obj) end)
    end
  end

  @doc """
  Deletes a conversation and tells BOTH people, so whoever is still in the
  app clears it at once (the other one rebuilds from /api/state on return).
  The conversation row is TAKEN atomically: only the call that really
  removed it announces it — two racing deletes (or a delete of a chat that
  is already gone) never say "closed" twice. Write order as documented
  above: the index rows, THEN the conversation.
  """
  def delete_conversation({a, b} = key) do
    :ets.delete(@by_user, {a, key})
    :ets.delete(@by_user, {b, key})

    case :ets.take(@conversations, key) do
      [] ->
        :ok

      [_] ->
        :ets.delete(@messages, key)
        :ets.delete(@spots, {key, a})
        :ets.delete(@spots, {key, b})
        HoodrideWeb.Endpoint.broadcast("user:#{a}", "chat_closed", %{peer_id: b})
        HoodrideWeb.Endpoint.broadcast("user:#{b}", "chat_closed", %{peer_id: a})
        :ok
    end
  end

  def all_conversations, do: :ets.tab2list(@conversations)

  @doc """
  Sweeper repair for the per-user index, in one pass when healthy.

  It walks the index rows, checking each belongs to one of its own
  conversation's two people and that the conversation exists (a hash
  lookup). If every row passes, each conversation has at most its two
  rows; if the index also holds exactly 2 × conversations rows, each has
  exactly two. So the index is whole, and nothing else runs.

  Otherwise the bad rows are dropped and missing ones re-added. A send
  racing a stale-row removal is re-indexed next sweep. Reads in pages
  (Hoodride.ETS): nothing copies a whole table.
  """
  def heal_index do
    import Hoodride.ETS, only: [each_match: 3, fold_match: 4]

    bad =
      fold_match(@by_user, [{:"$1", [], [:"$1"]}], [], fn {{user, {a, b} = key}} = row, acc ->
        if (user == a or user == b) and :ets.member(@conversations, key),
          do: acc,
          else: [row | acc]
      end)

    unless bad == [] and :ets.info(@by_user, :size) == 2 * :ets.info(@conversations, :size) do
      # (the repair log — Hoodride.Sweeper)
      Logger.warning("repair: chat index ×1")
      # re-checked: a row's conversation may have been (re)created since
      for {{user, {a, b} = key}} = row <- bad,
          (user != a and user != b) or not :ets.member(@conversations, key) do
        :ets.delete_object(@by_user, row)
      end

      each_match(@conversations, [{{:"$1", :_}, [], [:"$1"]}], fn {a, b} = key ->
        unless :ets.member(@by_user, {a, key}) and :ets.member(@by_user, {b, key}),
          do: index(key)
      end)
    end

    # a block whose conversation is gone (a send racing a delete) goes too
    each_match(@spots, [{{{:"$1", :_}, :_, :_}, [], [:"$_"]}], fn {{key, _}, _, _} = row ->
      unless :ets.member(@conversations, key), do: :ets.delete_object(@spots, row)
    end)

    # …and so does a MESSAGE whose conversation is gone: the same race can
    # write it after the chat and its messages were removed. Losing it is
    # the accepted trade-off; its text staying in memory until a restart
    # broke the privacy page's "gone soon after" (ChatOrphanTest). The exact
    # row only — a re-created chat's newer messages are other rows
    each_match(@messages, [{{:_, :_, :_, :_, :_}, [], [:"$_"]}], fn {key, _, _, _, _} = row ->
      unless :ets.member(@conversations, key), do: :ets.delete_object(@messages, row)
    end)

    :ok
  end
end
