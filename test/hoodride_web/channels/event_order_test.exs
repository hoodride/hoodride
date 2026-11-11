defmodule HoodrideWeb.EventOrderTest do
  @moduledoc """
  A request's answer never overtakes the server's reply to it (R2, owner
  2026-11-11). "declined", "expired" and "ride started" are broadcast to the
  person's own topic; Phoenix sends such a broadcast straight to the phone,
  past the channel — so one sent while the channel was still answering the
  request ("request sent") could arrive FIRST. The app then showed
  "Requested…" for a request already gone. Now they go through the channel,
  in line behind its replies.
  """
  use ExUnit.Case

  import Phoenix.ChannelTest
  @endpoint HoodrideWeb.Endpoint

  setup do
    :ok = Ecto.Adapters.SQL.Sandbox.checkout(Hoodride.Repo)
    Ecto.Adapters.SQL.Sandbox.mode(Hoodride.Repo, {:shared, self()})
    Hoodride.TestHelpers.scrub_live_state()

    {:ok, user} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "eo-u", name: "EO"})

    {:ok, sock} =
      connect(HoodrideWeb.UserSocket, %{},
        connect_info: %{session: Hoodride.TestHelpers.session_for(user.id)}
      )

    {:ok, _, chan} = subscribe_and_join(sock, "user:#{user.id}", %{})
    %{user: user, chan: chan}
  end

  for event <- ["request_declined", "request_expired", "ride_started"] do
    test "'#{event}' sent while the channel answers a push: arrives AFTER that answer",
         %{user: user, chan: chan} do
      # the channel busy with a push (as with request_ride: the answer is
      # broadcast from inside it, before its reply)
      :sys.suspend(chan.channel_pid)
      ref = push(chan, "cancel_request", %{})
      HoodrideWeb.Endpoint.broadcast("user:#{user.id}", unquote(event), %{by_id: 1})
      :sys.resume(chan.channel_pid)

      first =
        receive do
          %Phoenix.Socket.Reply{ref: ^ref} -> :reply
          %Phoenix.Socket.Message{event: unquote(event)} -> :event
        after
          2_000 -> :nothing
        end

      assert first == :reply, "'#{unquote(event)}' overtook the reply"
      assert_receive %Phoenix.Socket.Message{event: unquote(event), payload: %{by_id: 1}}
    end
  end
end
