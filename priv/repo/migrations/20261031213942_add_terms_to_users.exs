defmodule Hoodride.Repo.Migrations.AddTermsToUsers do
  use Ecto.Migration

  # The Terms of Use (Hoodride.Terms): when the account agreed (ms since
  # epoch) and to which version — the proof of the one-time "I agree".
  # Empty until then; gone with the account.
  def change do
    alter table(:users) do
      add :terms_accepted_at, :integer
      add :terms_version, :string
    end
  end
end
