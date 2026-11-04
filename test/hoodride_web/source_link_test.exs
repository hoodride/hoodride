defmodule HoodrideWeb.SourceLinkTest do
  @moduledoc """
  The code is public (owner, 2026-11-04): GitHub's mark links to it from the
  sign-in page and the menu. GitHub's brand rules: its own logo file,
  unchanged, smaller than ours; it isn't ours to license.
  (The visitor journey checks both on screen.)
  """
  use ExUnit.Case, async: true

  @static "priv/static"
  @repo "https://github.com/hoodride/hoodride"
  @discord "https://discord.gg/ehce7eGQFt"

  test "GitHub's white Invertocat, exactly as GitHub ships it" do
    svg = File.read!(Path.join(@static, "github-invertocat-white.svg"))

    # GitHub_Logos.zip → SVG/GitHub_Invertocat_White.svg (brand.github.com, 2026-11-04)
    assert :crypto.hash(:sha256, svg) |> Base.encode16(case: :lower) ==
             "ccd84c89b1056345608fc3489357f8acc7397e49a3cdc2d418b6c8016911d47b"

    refute svg =~ ~r/<script|on\w+=|href=/i
  end

  test "Discord's white symbol, exactly as Discord ships it" do
    svg = File.read!(Path.join(@static, "discord-symbol-white.svg"))

    # discord.com/branding → Discord_Symbol_White/Discord-Symbol-White.svg (2026-11-04)
    assert :crypto.hash(:sha256, svg) |> Base.encode16(case: :lower) ==
             "de4cc484cdc0e3a8f3a58a84b0c80c5ac8acefeebf730930545ff3b279b5d0a3"

    refute svg =~ ~r/<script|on\w+=|href=/i
  end

  test "the sign-in page and the menu link to the code, in a new tab" do
    html = File.read!(Path.join(@static, "index.html"))

    link =
      ~s(<a class="source-link" href="#{@repo}" target="_blank" rel="noopener" title="Source code on GitHub" aria-label="Source code on GitHub">)

    [login] = Regex.run(~r{<p class="source-login">.*?</p>}s, html)

    assert login =~
             link <>
               ~s(<img src="github-invertocat-white.svg" alt="" width="20" height="20" /></a>)

    # the menu: its own line between Sign out and the legal links — not
    # beside Delete account, which stays last (owner, 2026-11-04)
    [legal] = Regex.run(~r{<p class="drawer-legal muted">.*?</p>}s, html)
    refute legal =~ "source-link"

    [source] = Regex.run(~r{<p class="drawer-source">.*?</p>}s, html)

    # GitHub, then Discord (owner, 2026-11-04: the menu only)
    assert source ==
             ~s(<p class="drawer-source">) <>
               link <>
               ~s(<img src="github-invertocat-white.svg" alt="" width="16" height="16" /></a>) <>
               ~s(<a class="source-link" href="#{@discord}" target="_blank" rel="noopener" title="Hood Ride on Discord" aria-label="Hood Ride on Discord">) <>
               ~s(<img src="discord-symbol-white.svg" alt="" width="21" height="16" /></a></p>)

    # Discord on the sign-in page too, right after GitHub (owner,
    # 2026-11-04), sized to it; the same invite as the README
    assert login =~
             ~s(<img src="github-invertocat-white.svg" alt="" width="20" height="20" /></a>) <>
               ~s(<a class="source-link" href="#{@discord}" target="_blank" rel="noopener" title="Hood Ride on Discord" aria-label="Hood Ride on Discord">) <>
               ~s(<img src="discord-symbol-white.svg" alt="" width="26" height="20" /></a></p>)

    assert File.read!("README.md") =~ "(#{@discord})"

    {logout, _} = :binary.match(html, ~s(id="btn-logout"))
    {cat, _} = :binary.match(html, ~s(<p class="drawer-source">))
    {delete, _} = :binary.match(html, ~s(id="btn-delete"))
    assert logout < cat and cat < delete

    # and it's the README's repository
    assert File.read!("README.md") =~ "git clone #{@repo}.git"
  end

  test "served, kept for offline use, and credited as GitHub's" do
    for f <- ~w(github-invertocat-white.svg discord-symbol-white.svg) do
      assert f in HoodrideWeb.static_paths()
      assert File.read!(Path.join(@static, "sw.js")) =~ ~s("#{f}")
    end

    third = File.read!("THIRD-PARTY.md")
    assert third =~ "`github-invertocat-white.svg` is GitHub's own logo, unchanged"
    assert third =~ "`discord-symbol-white.svg` is Discord's own symbol, unchanged"
  end
end
