defmodule HoodrideWeb.CloudflareCheckTest do
  @moduledoc """
  CSP violation reports are off (HoodrideWeb.CSP); their one real catch —
  Cloudflare adding a script to our pages on the way out — is checked after
  every deploy instead (deploy/cloudflare_check.sh, tried against the live
  site 2026-10-29: the three known additions recognised, each one warned
  about with an empty list). These keep it wired in and its list honest.
  """
  use ExUnit.Case, async: true

  test "deploy.sh runs the check once the new release answers" do
    deploy = File.read!("deploy/deploy.sh")
    [_, after_live] = String.split(deploy, ~s(echo "live: $NEW"), parts: 2)
    assert after_live =~ ~r/^\s*#.*\n\s*"\$\(dirname "\$0"\)\/cloudflare_check\.sh"/
  end

  test "every known addition is one the CSP allows (else the list hides a blocked script)" do
    csp = HoodrideWeb.CSP.policy()

    for line <- File.read!("deploy/cloudflare_expected.txt") |> String.split("\n", trim: true) do
      [_page, item] = String.split(line, " ", parts: 2)

      allowed =
        cond do
          String.starts_with?(item, "/cdn-cgi/") -> csp =~ "script-src 'self'"
          true -> csp =~ "https://" <> (item |> String.split("/") |> hd())
        end

      assert allowed, "#{item} is expected from Cloudflare but the CSP blocks it"
    end
  end
end
