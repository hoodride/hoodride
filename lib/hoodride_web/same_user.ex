defmodule HoodrideWeb.SameUser do
  @moduledoc """
  One account per tab (owner, 2026-11-08). Every tab of a browser shares one
  sign-in cookie: when the browser becomes account B (another tab signed out
  and in, a sign-in page left open…) while a tab still shows A, that tab's
  requests used to act on B — delete account deleted B, save car saved to B,
  sign out signed B out, the state answer drew B's data as A's.

  The app says which account a tab shows in `x-hood-user` (apiFetch). A
  different signed-in account: 409 `other_account`, marked by the response
  header `x-hood-other-account` (the app checks the header — logout's own
  409s carry a body the app reads), and nothing is done; the tab shows the
  "Use here" cover. No header (an old app copy, the signed-out screen, the
  browser's own CSP reports) or nobody signed in: unchanged.

  After HttpBudget: a refused request still spends its budget, as every
  refusal (HoodrideWeb.CrossOrigin).
  """
  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case {conn.assigns[:current_user], get_req_header(conn, "x-hood-user")} do
      {nil, _} -> conn
      {_, []} -> conn
      # the very account signed in (sent twice — never by the app — is refused)
      {%{id: id}, [shown]} -> if shown == Integer.to_string(id), do: conn, else: refuse(conn)
      _ -> refuse(conn)
    end
  end

  defp refuse(conn) do
    conn
    |> put_resp_header("x-hood-other-account", "1")
    |> put_status(409)
    |> Phoenix.Controller.json(%{error: "other_account"})
    |> halt()
  end
end
