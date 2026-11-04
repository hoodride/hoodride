defmodule Hoodride.Repo.Migrations.ClearOutsidePhotos do
  @moduledoc """
  Profile photos are now our own copy (Hoodride.Avatars), made at sign-in.
  Links to Google's or Facebook's servers stored before are cleared: they
  told the provider who viewed whom, and Facebook's showed a silhouette.
  🙂 until the next sign-in makes the copy. Dev-login photos (local only)
  are left alone.
  """
  use Ecto.Migration

  def up, do: execute(clear_sql())

  # nothing to bring back: the next sign-in refreshes the photo anyway
  def down, do: :ok

  @doc false
  def clear_sql,
    do:
      "UPDATE users SET photo = NULL WHERE photo IS NOT NULL AND photo NOT LIKE '/avatars/%' AND provider <> 'dev'"
end
