#!/usr/bin/env bash
# Copy the PC's board (Postgres on 127.0.0.1:5434) to the VPS, replacing the VPS's copy.
# Run on the PC in Git Bash, from the repo:
#
#   bash deploy/copy-to-vps.sh            # snapshot: the PC board keeps running; run it again any time to refresh
#   bash deploy/copy-to-vps.sh --final    # the cutover (docs/ops/deploy.md step 8): stop the PC board server first
#
# --final freezes the PC's board: its database turns read-only (every session's write fails from then on) and open
# connections are closed, so nothing is written after the dump. Postgres keeps running, a read-only copy; going back is
#   psql -h 127.0.0.1 -p 5434 -U cb -d postgres -c "alter database claude_board reset default_transaction_read_only"
# It also marks the VPS, and this script refuses to copy over a VPS marked final: that would throw away everything
# written there since.
# The dump holds client work: it goes only to the VPS (VPS=vps2, Ahmed's choice) and is deleted on both ends.
set -euo pipefail

VPS=${VPS:-vps2}
DIR=/opt/claude-board/deploy
PGBIN=${PGBIN:-"/c/Program Files/PostgreSQL/16/bin"}
DB=${DB:-claude_board}   # the PC database to copy (tests: DB=claude_board_test_upgrade)
FINAL=0; [ "${1:-}" = --final ] && FINAL=1
DUMP="$(mktemp -d)/cb-copy.dump"
say() { printf '\n== %s\n' "$*"; }

say "checking $VPS"
ssh -o BatchMode=yes "$VPS" "test -f $DIR/.env && cd $DIR && docker compose ps --status running --services | grep -qx db" \
  || { echo "the VPS stack isn't running: cd $DIR && docker compose up -d (deploy.md steps 1-3)"; exit 1; }
if ssh -o BatchMode=yes "$VPS" "test -e $DIR/.cutover"; then
  echo "$VPS is the live board since $(ssh "$VPS" "cat $DIR/.cutover"): copying over it would lose what was written there."
  echo "If you really mean to, remove $DIR/.cutover on the VPS first."
  exit 1
fi

if [ $FINAL = 1 ]; then
  say "final copy: freezing the PC's Postgres"
  if curl -s -o /dev/null --max-time 3 http://localhost:4747/healthz; then
    echo "the PC board server still answers on :4747. Stop it first (Ctrl+C in its window), then run this again."; exit 1
  fi
  # read-only, not a Postgres restart: a Postgres started from an agent's session on this PC once crashed (no desktop)
  "$PGBIN/psql.exe" -h 127.0.0.1 -p 5434 -U cb -d postgres -Atq -c "alter database \"$DB\" set default_transaction_read_only = on" \
    -c "select count(pg_terminate_backend(pid)) from pg_stat_activity where datname = '$DB' and pid <> pg_backend_pid()" >/dev/null
  echo "the PC's $DB is read-only now"
fi

say "dumping the PC's board"
"$PGBIN/pg_dump.exe" -h 127.0.0.1 -p 5434 -U cb -d "$DB" -Fc -f "$DUMP"
COUNTS="select (select count(*) from cb.tasks)||' tasks, '||(select count(*) from cb.questions)||' questions, '||(select count(*) from cb.events)||' events'"
echo "PC: $("$PGBIN/psql.exe" -h 127.0.0.1 -p 5434 -U cb -d "$DB" -Atc "$COUNTS")"
SUM=$(md5sum "$DUMP" | cut -d' ' -f1)
echo "$(du -h "$DUMP" | cut -f1) dump, md5 $SUM"

say "copying to $VPS"
scp -q "$DUMP" "$VPS:/tmp/cb-copy.dump"
rm -f "$DUMP"

say "restoring on $VPS (the board stops for a few seconds)"
ssh -o BatchMode=yes "$VPS" bash -s -- "$SUM" "$FINAL" <<'REMOTE'
set -euo pipefail
SUM=$1 FINAL=$2
cd /opt/claude-board/deploy
chmod 600 /tmp/cb-copy.dump
[ "$(md5sum /tmp/cb-copy.dump | cut -d' ' -f1)" = "$SUM" ] || { echo "the dump arrived damaged (md5 differs): nothing changed; run it again"; rm -f /tmp/cb-copy.dump; exit 1; }
# this script arrives on stdin: every docker command but the restore reads /dev/null, or it would eat the rest
docker compose stop board </dev/null
docker compose exec -T db dropdb -U cb --force --if-exists claude_board </dev/null
docker compose exec -T db createdb -U cb claude_board </dev/null
docker compose exec -T db pg_restore -U cb -d claude_board --no-owner --exit-on-error < /tmp/cb-copy.dump
shred -u /tmp/cb-copy.dump
docker compose up -d board </dev/null   # applies this branch's schema over the copy, then serves
for i in $(seq 1 30); do curl -sf localhost:4747/healthz >/dev/null && break; sleep 2; done
curl -s localhost:4747/healthz; echo
echo "VPS: $(docker compose exec -T db psql -U cb -d claude_board -Atc "select (select count(*) from cb.tasks)||' tasks, '||(select count(*) from cb.questions)||' questions, '||(select count(*) from cb.events)||' events'" </dev/null)"
[ "$FINAL" = 1 ] && date -u +%FT%TZ > .cutover && echo "marked: $(cat .cutover). This VPS is the board now."
true
REMOTE

if [ $FINAL = 1 ]; then
  say "next (deploy.md step 8, from 6): the first admin, the pollers, HTTPS, the workers"
else
  say "done: the VPS has a copy of the board as of now (the PC is still the board). Run it again to refresh."
fi
