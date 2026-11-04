defmodule Hoodride.Roles do
  @moduledoc """
  Who you are on the map RIGHT NOW, derived from the live tables — never
  from what an app says about itself. It decides what the server sends you:

    :in_ride → nothing from the map (any seat, including a :pending one)
    :driver  → raised hands + hand counts (your car is on the map)
    :viewer  → cars + car counts (everyone else)

  Precedence is that order: a ride beats a car, a car beats nothing.

  Every place that can change a role calls `changed/1` AFTER its table
  write. The ping carries nothing: each listener re-derives with `of/1`, so
  a ping arriving early, late or twice can never mislead anyone.
  """

  @type t :: :in_ride | :driver | :viewer

  @spec of(term) :: t
  def of(user_id) do
    cond do
      :ets.member(:rides_by_user, user_id) -> :in_ride
      :ets.member(:geo_drivers, user_id) -> :driver
      true -> :viewer
    end
  end

  @doc "The map layer a role receives: :drivers (cars), :hands, or nil (nothing)."
  def layer(:viewer), do: :drivers
  def layer(:driver), do: :hands
  def layer(:in_ride), do: nil

  def topic(user_id), do: "role:#{user_id}"

  @doc "Tell `user_id`'s map channel to re-derive its role (call AFTER the write)."
  def changed(user_id), do: HoodrideWeb.Endpoint.broadcast(topic(user_id), "changed", %{})
end
