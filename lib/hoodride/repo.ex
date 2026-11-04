defmodule Hoodride.Repo do
  use Ecto.Repo,
    otp_app: :hoodride,
    adapter: Ecto.Adapters.SQLite3
end
