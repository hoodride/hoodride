defmodule Hoodride.Repo.Migrations.AddReplacedByToUserTokens do
  use Ecto.Migration

  # A token replaced by its weekly renewal remembers its replacement (the
  # replacement's SHA-256): it is never renewed a second time, except when
  # that replacement was never used — its reply was lost on the way
  # (Hoodride.SessionTokens.rotate/1; the key fix, owner 2026-11-12: a
  # replayed old cookie made a new token on every request).
  # `unused`: a replacement no request has used yet (1) — kept here so a
  # restart doesn't forget it (review, 2026-11-12: a lost reply, then a
  # deploy, and the phone could never renew again).
  # Expand only: new columns, nothing dropped or renamed.
  # Never edit this file once it may have run in production: add a new one.
  def change do
    alter table(:user_tokens) do
      add :replaced_by, :binary
      add :unused, :integer, null: false, default: 0
    end
  end
end
