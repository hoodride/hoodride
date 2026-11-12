defmodule Hoodride.Accounts.User do
  use Ecto.Schema
  import Ecto.Changeset

  schema "users" do
    field :provider, :string
    field :provider_id, :string
    field :name, :string
    field :photo, :string
    # ms since epoch of the last sign-out: older sessions/tokens are refused
    field :logged_out_at, :integer
    # "Your car": what riders look for on the street (no plate)
    field :car_color, :string
    field :car_make, :string
    field :car_model, :string
    # the Terms of Use agreed to (Hoodride.Terms): when (ms) and which version
    field :terms_accepted_at, :integer
    field :terms_version, :string

    timestamps()
  end

  # the most common US car colors (iSeeCars 2025: white, black, gray, blue,
  # silver, red ≈ 96%), then the rest — a list keeps the label clean
  @car_colors ~w(White Black Gray Silver Blue Red Green Brown Beige Yellow Orange Gold Purple Other)
  @car_text_max Hoodride.Limits.car_text_chars()

  def car_colors, do: @car_colors

  @doc """
  Color, make and model, all three required. Make and model are trimmed
  and their spaces squeezed, then 1-24 characters; anything invisible or
  that could disguise the text (control characters, zero-width spaces,
  right-to-left overrides — Unicode category C) is refused, not stripped:
  a stranger reads this on a card.
  """
  def car_changeset(user, attrs) do
    attrs = %{
      car_color: attrs["color"],
      car_make: tidy(attrs["make"]),
      car_model: tidy(attrs["model"])
    }

    user
    |> cast(attrs, [:car_color, :car_make, :car_model], empty_values: [nil, ""])
    |> validate_required([:car_color, :car_make, :car_model])
    |> validate_inclusion(:car_color, @car_colors)
    |> validate_length(:car_make, max: @car_text_max)
    |> validate_length(:car_model, max: @car_text_max)
    |> validate_format(:car_make, ~r/\A[^\p{C}]*\z/u)
    |> validate_format(:car_model, ~r/\A[^\p{C}]*\z/u)
  end

  # trims and squeezes ordinary spaces only: a tab or newline stays, and is
  # refused as a control character
  defp tidy(s) when is_binary(s), do: s |> String.trim(" ") |> String.replace(~r/ {2,}/, " ")
  defp tidy(other), do: other

  def oauth_changeset(user, attrs) do
    user
    |> cast(attrs, [:provider, :provider_id, :name, :photo])
    |> validate_required([:provider, :provider_id, :name])
    |> unique_constraint([:provider, :provider_id])
    # the primary key is a random id (Accounts.random_id); a clash retries
    |> unique_constraint(:id, name: :users_id_index)
  end
end
