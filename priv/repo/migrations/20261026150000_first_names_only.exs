defmodule Hoodride.Repo.Migrations.FirstNamesOnly do
  use Ecto.Migration

  # Strangers see first names only (Hoodride.Accounts.first_name/2). Names
  # stored before that: the first word (the next sign-in replaces it with
  # the provider's own first name); an email stored by the old fallback →
  # "Neighbor". Dev-login names are left alone (local only). Plain SQL, so
  # this stays right whatever the app code becomes.
  def shorten_sql do
    """
    UPDATE users SET name = CASE
      WHEN name LIKE '%@%' THEN 'Neighbor'
      WHEN instr(trim(name), ' ') > 0 THEN substr(trim(name), 1, instr(trim(name), ' ') - 1)
      ELSE trim(name)
    END
    WHERE provider <> 'dev'
    """
  end

  def up, do: execute(shorten_sql())

  # the full names aren't kept: nothing to restore
  def down, do: :ok
end
