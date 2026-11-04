defmodule HoodrideWeb.WsFrameLimitTest do
  @moduledoc """
  The live connection accepts messages up to 64 KB (2026-10-29). The
  default was 10 MB (WebSockAdapter's), so one signed-in troublemaker could
  push megabytes per message; the largest thing the app sends is a chat
  message (≤ 20 KB, HoodrideWeb.UserChannel). Bigger: closed with 1009
  ("message too big", RFC 6455). The limit is on what the server ACCEPTS —
  what it sends is unaffected. Over a REAL connection (Bandit, as in prod):
  ChannelTest has no transport.
  """
  use ExUnit.Case, async: false

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})

    {:ok, user} =
      Hoodride.Accounts.upsert_oauth_user(%{
        provider: "dev",
        provider_id: "ws-limit",
        name: "Limit"
      })

    pid =
      start_supervised!(
        {Bandit, plug: HoodrideWeb.Endpoint, scheme: :http, ip: :loopback, port: 0}
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(pid)
    %{port: port, token: HoodrideWeb.Auth.socket_token(user)}
  end

  defp connect(port, token) do
    {:ok, s} = :gen_tcp.connect(~c"127.0.0.1", port, [:binary, active: false, nodelay: true])

    :ok =
      :gen_tcp.send(
        s,
        "GET /socket/websocket?vsn=2.0.0&token=#{URI.encode_www_form(token)} HTTP/1.1\r\n" <>
          "Host: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" <>
          "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
      )

    {:ok, head} = :gen_tcp.recv(s, 0, 3_000)
    assert head =~ "101 Switching Protocols"
    s
  end

  # one masked text frame (clients must mask, RFC 6455 §5.3)
  defp text_frame(payload) do
    len = byte_size(payload)
    mask = :crypto.strong_rand_bytes(4)

    size =
      cond do
        len < 126 -> <<1::1, len::7>>
        len < 65_536 -> <<1::1, 126::7, len::16>>
        true -> <<1::1, 127::7, len::64>>
      end

    <<1::1, 0::3, 1::4>> <> size <> mask <> masked(payload, mask)
  end

  defp masked(payload, <<m::binary-size(4)>>) do
    key = :binary.copy(m, div(byte_size(payload), 4) + 1)
    :crypto.exor(payload, binary_part(key, 0, byte_size(payload)))
  end

  # every frame the server sends until it closes or goes quiet:
  # [{:text, payload} | {:close, code}]
  defp frames(s, acc \\ "", out \\ []) do
    case parse(acc) do
      {frame, rest} ->
        frames(s, rest, [frame | out])

      :more ->
        case :gen_tcp.recv(s, 0, 2_000) do
          {:ok, data} -> frames(s, acc <> data, out)
          {:error, _} -> Enum.reverse(out)
        end
    end
  end

  defp parse(<<_fin::1, _::3, op::4, 0::1, 126::7, len::16, p::binary-size(len), rest::binary>>),
    do: {decode(op, p), rest}

  defp parse(<<_fin::1, _::3, op::4, 0::1, len::7, p::binary-size(len), rest::binary>>)
       when len < 126,
       do: {decode(op, p), rest}

  defp parse(_), do: :more

  defp decode(8, <<code::16, _::binary>>), do: {:close, code}
  defp decode(1, p), do: {:text, p}
  defp decode(op, _), do: {:op, op}

  # a heartbeat padded to `size` bytes: Phoenix answers any heartbeat
  defp heartbeat(size) do
    base = ~s(["1","1","phoenix","heartbeat",{"pad":""}])

    ~s(["1","1","phoenix","heartbeat",{"pad":") <>
      String.duplicate("x", size - byte_size(base)) <> ~s("}])
  end

  test "a message under 64 KB is answered", %{port: port, token: token} do
    s = connect(port, token)
    :ok = :gen_tcp.send(s, text_frame(heartbeat(60_000)))
    assert [{:text, reply} | _] = frames(s)
    assert reply =~ ~s("phx_reply")
    :gen_tcp.close(s)
  end

  test "a message over 64 KB closes the connection with 1009 (message too big)", %{
    port: port,
    token: token
  } do
    s = connect(port, token)
    :ok = :gen_tcp.send(s, text_frame(heartbeat(70_000)))
    assert {:close, 1009} in frames(s)
    :gen_tcp.close(s)
  end

  # the frame's own header says how big it is: over the limit, the server
  # closes on the header alone — it never waits for, or reads, the body
  test "cut off before the body: a header announcing 70 KB alone gets 1009", %{
    port: port,
    token: token
  } do
    s = connect(port, token)
    # a masked text frame announcing 70,000 bytes — and nothing after it
    :ok =
      :gen_tcp.send(
        s,
        <<1::1, 0::3, 1::4, 1::1, 127::7, 70_000::64>> <> :crypto.strong_rand_bytes(4)
      )

    assert {:close, 1009} in frames(s)
    :gen_tcp.close(s)
  end

  test "…and it's the size: a header announcing 60 KB alone just waits for the body", %{
    port: port,
    token: token
  } do
    s = connect(port, token)

    :ok =
      :gen_tcp.send(
        s,
        <<1::1, 0::3, 1::4, 1::1, 126::7, 60_000::16>> <> :crypto.strong_rand_bytes(4)
      )

    refute {:close, 1009} in frames(s)
    :gen_tcp.close(s)
  end

  test "the 64 KB is just over the largest real message: a full chat message" do
    # 500 of the heaviest real characters, JSON-encoded in a send_msg push
    text = String.duplicate("👩🏻‍❤️‍💋‍👨🏼", 500)
    push = Jason.encode!(["1", "2", "user:1", "send_msg", %{"to" => 1, "text" => text}])
    assert byte_size(push) < 65_536
  end
end
