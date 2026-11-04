defmodule Hoodride.Terms do
  @moduledoc """
  The Terms of Use (priv/static/terms.html, owner 2026-10-31). Before the
  map, each account agrees once — "I agree" — to the CURRENT
  version: until then the server gives the app no connection token
  (AuthController.socket_token). The version is the page's effective date:
  a significant change gets a new date here and on the page (TermsTest ties
  them), and everyone is asked again.
  """

  # 2026-11-02: "people nearby" (s. 1), who sees what by the privacy
  # policy (s. 10), breaking these terms named in the
  # indemnity (s. 14), and the law's own deadline for
  # claims, no longer one year (s. 15) — owner
  @version "2026-11-02"

  @doc """
  The current version: the terms' effective date (ISO). (`config :hoodride,
  :terms_version` only for the browser journey that plays a new version.)
  """
  def version, do: Application.get_env(:hoodride, :terms_version, @version)

  @doc "The effective date as the page writes it (\"October 31, 2026\")."
  def effective_text, do: @version |> Date.from_iso8601!() |> Calendar.strftime("%B %-d, %Y")

  @doc "Has this user (or session user) agreed to the current version?"
  def agreed?(%{terms_version: v}) when is_binary(v), do: v == version()
  def agreed?(_), do: false
end
