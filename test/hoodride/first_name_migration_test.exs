defmodule Hoodride.FirstNameMigrationTest do
  @moduledoc """
  Names stored before first-names-only: shortened to the first word (the
  next sign-in replaces it with the provider's own first name); an email
  stored by the old fallback becomes "Neighbor". Dev-login names are left
  alone (local only; tests rely on them).
  """
  use Hoodride.DataCase, async: false

  alias Hoodride.Repo

  @migration "priv/repo/migrations/20261026150000_first_names_only.exs"

  setup_all do
    %{mod: Hoodride.TestHelpers.migration(@migration)}
  end

  defp insert(provider, name) do
    {:ok, u} =
      Hoodride.Accounts.upsert_oauth_user(%{provider: "dev", provider_id: "m-#{name}", name: "x"})

    Repo.query!("UPDATE users SET provider = ?, name = ? WHERE id = ?", [provider, name, u.id])
    u.id
  end

  defp name_of(id), do: Repo.get!(Hoodride.Accounts.User, id).name

  test "full names → first word; emails → Neighbor; dev names untouched", %{mod: mod} do
    full = insert("google", "Mary Ann Smith")
    single = insert("google", "Cher")
    spaced = insert("google", "  Dana   K ")
    email = insert("google", "secret@example.com")
    dev = insert("dev", "Settings Tester")

    Repo.query!(mod.shorten_sql())

    assert name_of(full) == "Mary"
    assert name_of(single) == "Cher"
    assert name_of(spaced) == "Dana"
    assert name_of(email) == "Neighbor"
    assert name_of(dev) == "Settings Tester"
  end
end
