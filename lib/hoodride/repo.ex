defmodule Hoodride.Repo do
  use Ecto.Repo,
    otp_app: :hoodride,
    adapter: Ecto.Adapters.SQLite3

  @doc """
  Is `e` the database being unavailable — busy, its pool full, or the
  repo itself restarting — rather than a bug? Ecto raises a plain
  RuntimeError ("could not lookup Ecto repo …") while the repo's
  supervisor restarts, which the "unavailable" rescues didn't know: those
  crashed connections and gave 500s (crash review 2026-11-14;
  Hoodride.RestartGapsTest). Anything else is a bug and must stay loud.
  """
  def down?(%DBConnection.ConnectionError{}), do: true
  def down?(%Exqlite.Error{}), do: true
  def down?(%RuntimeError{message: "could not lookup Ecto repo " <> _}), do: true
  def down?(_), do: false
end
