#!/bin/bash
# Erlang/OTP + Elixir for building releases, into ~/beam — the same versions
# as development. No sudo, nothing system-wide (`rm -rf ~/beam` undoes it).
# Each download is checked against its published SHA-256 before use.
#
#   deploy/install_beam.sh      (then deploy.sh finds them via ~/beam/env.sh)
set -euo pipefail
B="$HOME/beam"; mkdir -p "$B/dl"; cd "$B/dl"

OTP=29.1.2; ELIXIR=1.20.4
OTP_SHA=2cfca446976fc61962585a1c77e5d11ddb6f5fed83e84668a2c4acfaad60d22e  # builds.hex.pm builds.txt

echo "== Erlang/OTP $OTP (builds.hex.pm, ubuntu-24.04)"
curl -fsSL -o otp.tar.gz "https://builds.hex.pm/builds/otp/ubuntu-24.04/OTP-$OTP.tar.gz"
echo "$OTP_SHA  otp.tar.gz" | sha256sum -c -
# Install sets Erlang up IN PLACE (it copies nothing), so unpack to the final folder
rm -rf "$B/otp" && mkdir "$B/otp" && tar xzf otp.tar.gz -C "$B/otp" --strip-components=1
(cd "$B/otp" && ./Install -minimal "$B/otp" >/dev/null)

echo "== Elixir $ELIXIR (github.com/elixir-lang/elixir)"
curl -fsSL -o elixir.zip "https://github.com/elixir-lang/elixir/releases/download/v$ELIXIR/elixir-otp-29.zip"
curl -fsSL -o elixir.zip.sha256sum "https://github.com/elixir-lang/elixir/releases/download/v$ELIXIR/elixir-otp-29.zip.sha256sum"
echo "$(cut -d' ' -f1 elixir.zip.sha256sum)  elixir.zip" | sha256sum -c -
rm -rf "$B/elixir" && python3 -m zipfile -e elixir.zip "$B/elixir" && chmod +x "$B/elixir/bin/"*

cat > "$B/env.sh" <<EOF
export PATH="$B/otp/bin:$B/elixir/bin:\$PATH"
EOF
. "$B/env.sh"
mix local.hex --force --if-missing >/dev/null
mix local.rebar --force --if-missing >/dev/null
echo "== installed"
erl -noshell -eval 'io:format("OTP ~s~n",[erlang:system_info(otp_release)]), halt().'
elixir --version | tail -1
