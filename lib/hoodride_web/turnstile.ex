defmodule HoodrideWeb.Turnstile do
  @moduledoc """
  Cloudflare Turnstile — "a person, not a script?" — on sign-in START
  (review 2026-11-14): scripts can't start sign-ins in bulk from a shared
  address, and so can't make us send Google made-up codes. Invisible for
  nearly everyone; at most one checkbox. Free, no cap on checks
  (Cloudflare's plans page). Setup: GOOGLE_SETUP.md, "Turnstile".

  OFF until both keys are set (`TURNSTILE_SITE_KEY`, public — stamped on
  the page; `TURNSTILE_SECRET_KEY`, the server's only). Cloudflare's
  documented integration: the check is verified HERE (siteverify), never
  trusted from the browser; a pass is single-use and lives 5 minutes; its
  hostname and action must be ours; the visitor's address and an
  idempotency key go with it. Junk (no token, empty, over
  `turnstile_token_bytes`, not text) is refused without asking Cloudflare.

  Cloudflare itself unreachable — a network error, its 5xx, its
  "internal-error" — lets the sign-in through, logged ("have fallback
  behavior": a bot check that's down mustn't lock every person out). A
  FAILED check never does.
  """
  require Logger

  @verify "https://challenges.cloudflare.com/turnstile/v0/siteverify"
  @action "signin"

  @doc "Is the check on (both keys set)?"
  def on?, do: site_key() != nil and secret() != nil

  @doc "The public site key, or nil."
  def site_key, do: present(Application.get_env(:hoodride, :turnstile_site_key))

  defp secret, do: present(Application.get_env(:hoodride, :turnstile_secret))

  defp present(v) when is_binary(v) and v != "", do: v
  defp present(_), do: nil

  @doc "The browser's pass, checked with Cloudflare: `:ok` or `:error`."
  def verify(token, remote_ip) do
    if is_binary(token) and byte_size(token) in 1..Hoodride.Limits.turnstile_token_bytes(),
      do: ask(token, remote_ip),
      else: :error
  end

  defp ask(token, remote_ip) do
    wait = Hoodride.Limits.turnstile_verify_ms()

    form = [
      secret: secret(),
      response: token,
      remoteip: ip(remote_ip),
      idempotency_key: uuid()
    ]

    opts =
      [form: form, retry: false, receive_timeout: wait, connect_options: [timeout: wait]] ++
        Application.get_env(:hoodride, :turnstile_req, [])

    case Req.post(@verify, opts) do
      {:ok, %{status: 200, body: %{"success" => true} = body}} ->
        if body["hostname"] == HoodrideWeb.Endpoint.host() and body["action"] == @action,
          do: :ok,
          else: :error

      {:ok, %{status: 200, body: %{"success" => false, "error-codes" => codes}}}
      when is_list(codes) ->
        if "internal-error" in codes, do: let_through("internal-error"), else: :error

      {:ok, %{status: status}} when status >= 500 ->
        let_through("#{status}")

      {:error, e} ->
        let_through(inspect(e.__struct__))

      _ ->
        :error
    end
  end

  defp let_through(why) do
    Logger.warning("turnstile: Cloudflare's check unavailable (#{why}) — sign-in let through")
    :ok
  end

  defp ip(nil), do: ""
  defp ip(addr), do: addr |> :inet.ntoa() |> to_string()

  # a random (version 4) UUID — Cloudflare's idempotency key
  defp uuid do
    <<a::32, b::16, _::4, c::12, _::2, d::62>> = :crypto.strong_rand_bytes(16)
    <<u::128>> = <<a::32, b::16, 4::4, c::12, 2::2, d::62>>
    hex = u |> Integer.to_string(16) |> String.downcase() |> String.pad_leading(32, "0")

    Enum.join(
      [
        binary_part(hex, 0, 8),
        binary_part(hex, 8, 4),
        binary_part(hex, 12, 4),
        binary_part(hex, 16, 4),
        binary_part(hex, 20, 12)
      ],
      "-"
    )
  end
end
