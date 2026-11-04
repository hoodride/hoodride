defmodule HoodrideWeb.NoCommentsTest do
  @moduledoc """
  No developer notes in what the public gets (owner, 2026-11-02): the deploy
  build (Mix.Tasks.Hoodride.Minify.build/4) minifies our CSS with esbuild,
  as it does our JS — ordinary comments go, as Chrome's Lighthouse
  guidance has it ("minify … before you deploy") — and takes the comments
  out of the pages the server sends (OWASP WSTG-INFO-05: comments in
  production pages leak). The repo keeps every comment.
  """
  use ExUnit.Case, async: false

  alias Mix.Tasks.Hoodride.Minify

  @static "priv/static"

  setup_all do
    out =
      Path.join(System.tmp_dir!(), "hoodride_nocomments_#{System.unique_integer([:positive])}")

    File.mkdir_p!(out)
    on_exit(fn -> File.rm_rf!(out) end)
    %{out: out, status: Minify.build(@static, out)}
  end

  # what a page says once its comments are gone, spacing aside
  defp words(html) do
    html
    |> then(&Regex.replace(~r/<!--(?:(?!-->).)*-->/s, &1, ""))
    |> String.split()
  end

  test "every page: no comment left, and nothing else changed", %{out: out, status: status} do
    assert status == 0

    for page <- Minify.pages() do
      src = File.read!(Path.join(@static, page))
      min = File.read!(Path.join(out, page))
      assert src =~ "<!--", "#{page}: the source keeps its notes"
      refute min =~ "<!--", "#{page}: a comment left"
      assert words(min) == words(src), "#{page}: more than the comments changed"
    end
  end

  test "every page the server sends is in the list (a new one can't be forgotten)" do
    on_disk = @static |> File.ls!() |> Enum.filter(&String.ends_with?(&1, ".html")) |> Enum.sort()
    assert Enum.sort(Minify.pages()) == on_disk
  end

  # what keeps a plain comment strip safe: nothing in the pages where
  # "<!--" could be text, not a comment
  test "no inline script, style, textarea or pre in any page" do
    for page <- Minify.pages() do
      html = File.read!(Path.join(@static, page))
      refute html =~ ~r/<script(\s[^>]*)?>[^<]/, "#{page}: an inline script"
      refute html =~ ~r/<(style|textarea|pre)[\s>]/, "#{page}: style, textarea or pre"
    end
  end

  test "our stylesheets: minified, no comment left, the rules kept", %{out: out} do
    assert Enum.sort(Minify.css_files()) == ["privacy.css", "styles.css"]
    refute "maplibre-gl.css" in Minify.css_files(), "a library's own file is left alone"

    for css <- Minify.css_files() do
      src = File.read!(Path.join(@static, css))
      min = File.read!(Path.join(out, css))
      assert src =~ "/*"
      refute min =~ "/*", "#{css}: a comment left"
      refute min =~ "sourceMappingURL", "#{css}: never linked to its source map"
      assert byte_size(min) < byte_size(src)
    end

    styles = File.read!(Path.join(out, "styles.css"))
    assert styles =~ ".bottom-controls>*{pointer-events:auto}"
    assert File.read!(Path.join(out, "privacy.css")) =~ ".notfound .home{"
  end

  test "a comment ending mid-line never takes the markup after it" do
    html = "<p>a</p>\n  <!-- one --> <b>keep</b>\n<!-- two -->\n<i>also</i>\n"
    out = Minify.strip_html_comments(html)
    assert out =~ "<b>keep</b>"
    assert out =~ "<i>also</i>"
    refute out =~ "<!--"
  end

  test "deploy.sh builds the release's files in place: JS, CSS and pages" do
    sh = File.read!("deploy/deploy.sh")
    assert sh =~ ~s(mix hoodride.minify --in-place "$STATIC")
  end
end
