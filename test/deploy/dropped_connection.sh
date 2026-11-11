#!/bin/bash
# The ssh connection dropping DURING the health check, on Linux (real
# symlinks, real SIGPIPE): the deploy's output reader dies, then a hang-up.
# Run by DeployRollbackTest through WSL. Usage: dropped_connection.sh PROJECT SWITCH
set -u
PROJ="$1"; SWITCH="$2"
OLD=20261111-080000; NEW=20261111-090000
R="$(mktemp -d)"; A="$R/app"; mkdir -p "$A/releases/$OLD" "$A/releases/$NEW" "$R/db"
ln -sfn "$A/releases/$OLD" "$A/current"; printf 'accounts v1\n' > "$R/db/hoodride.db"

cat > "$R/systemctl.sh" <<SC
#!/bin/bash
rel="\$(basename "\$(readlink -f "$A/current")")"
case "\$1" in
  stop) echo stop >> "$A/log" ;;
  start) echo "start \$rel" >> "$A/log"; [ "\$rel" = "$NEW" ] && echo "changed" >> "$R/db/hoodride.db"; exit 0 ;;
esac
SC
printf '#!/bin/bash\nexec bash "%s/deploy/db_copy.sh" "$@"\n' "$PROJ" > "$R/dbcopy.sh"

# the check, on the new release: the connection drops (reader killed,
# then a hang-up to the deploy), and it never answers
cat > "$R/health.sh" <<'HC'
#!/bin/bash
rel="$(basename "$(readlink -f "$HOODRIDE_APP/current")")"
[ "$rel" = "$FAKE_NEW" ] || exit 0
kill "$(cat "$FAKE_R/reader")"
sleep 0.5
kill -HUP "$1"
sleep 1
exit 1
HC

# the reader: what ssh would be, writing its pid first
cat > "$R/reader.sh" <<'RD'
#!/bin/bash
echo $$ > "$FAKE_R/reader"
exec cat > /dev/null
RD
chmod +x "$R"/*.sh

export HOODRIDE_DB_DIR="$R/db" HOODRIDE_DB_COPIES="$R/copies" HOODRIDE_APP="$A" \
  HOODRIDE_DEPLOY_LOG="$R/deploy.log" HOODRIDE_SYSTEMCTL="$R/systemctl.sh" \
  HOODRIDE_DBCOPY="$R/dbcopy.sh" FAKE_R="$R" FAKE_NEW="$NEW" \
  HOODRIDE_HEALTHY="$R/health.sh \$PPID"
bash "$SWITCH" "$A/releases/$NEW" | "$R/reader.sh"
sleep 2
echo "live: $(basename "$(readlink -f "$A/current")")"
echo "log: $(tr '\n' ',' < "$A/log")"
echo "db: $(tr '\n' '|' < "$R/db/hoodride.db")"
