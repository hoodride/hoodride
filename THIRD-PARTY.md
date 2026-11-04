# Third-party code

Hood Ride itself is MIT-licensed (see `LICENSE`). It also ships these
files written by others, each under its own license:

| File in `priv/static/` | Project | License | License file |
|---|---|---|---|
| `maplibre-gl.js`, `maplibre-gl.css` | [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) 4.7.1 | BSD-3-Clause | `maplibre-gl.LICENSE.txt` |
| `h3-js.umd.js` | [h3-js](https://github.com/uber/h3-js) 4.5.0 (Uber) | Apache-2.0 | `h3-js.LICENSE.txt` |
| `phoenix.min.js` | [Phoenix](https://github.com/phoenixframework/phoenix) 1.8 | MIT | `phoenix.LICENSE.txt` |
| `hand.svg`, `pin.svg`, `compass.svg`, `chat.svg`, `person.svg`, `hand-avatar.svg` (from `icons.js`) | [Microsoft Fluent Emoji](https://github.com/microsoft/fluentui-emoji) | MIT | `fluent-emoji.LICENSE.txt` |

`github-invertocat-white.svg` is GitHub's own logo, unchanged, linking to
this project's code as [GitHub's brand rules](https://brand.github.com/foundations/logo)
allow. It isn't covered by the MIT license; GitHub owns it.
`discord-symbol-white.svg` is Discord's own symbol, unchanged, linking to the
Hood Ride Discord server as [Discord's brand rules](https://discord.com/branding)
allow. It isn't covered by the MIT license either; Discord owns it.

The server's libraries (Phoenix, Ecto, Bandit and others, listed in
`mix.lock`) are downloaded when you build. They're MIT or
Apache-2.0 licensed, and their licenses come with them.

The map's tiles and data come live from
[OpenFreeMap](https://openfreemap.org) and
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, and the
map shows their credit.

"Hood Ride", its name and logo, are not covered by the MIT license: please
use your own name and logo for your copy.
