defmodule HoodrideWeb.AvatarController do
  @moduledoc """
  GET /avatars/:name — a profile photo (Hoodride.Avatars), to SIGNED-IN
  people only: a photo is shown only to those who may see it (reveal, a
  chat, a ride), and its random name keeps it unguessable. The name must be
  exactly one of ours (no paths, no other types).

  `private` caching: each phone keeps it forever (a changed photo gets a new
  name), shared caches — Cloudflare — never, so the sign-in check can't be
  skipped. `nosniff` and a CSP that allows nothing: opened directly, the
  file is an image and can run nothing.
  """
  use HoodrideWeb, :controller

  alias Hoodride.Avatars

  @types %{"jpg" => "image/jpeg", "png" => "image/png", "webp" => "image/webp"}

  def show(conn, %{"name" => name}) do
    path = Path.join(Avatars.dir(), name)

    cond do
      conn.assigns.current_user == nil -> nothing(conn, 401)
      not Avatars.valid_name?(name) or not File.regular?(path) -> nothing(conn, 404)
      true -> photo(conn, path, Path.extname(name))
    end
  end

  # sobelow_skip ["XSS.ContentType", "Traversal.SendFile"]
  defp photo(conn, path, "." <> ext) do
    conn
    |> put_resp_header("cache-control", "private, max-age=31536000, immutable")
    |> put_resp_header("x-content-type-options", "nosniff")
    |> put_resp_header("content-security-policy", "default-src 'none'; sandbox")
    |> put_resp_content_type(Map.fetch!(@types, ext), nil)
    |> send_file(200, path)
  end

  defp nothing(conn, status) do
    conn |> put_resp_header("cache-control", "no-store") |> send_resp(status, "")
  end
end
