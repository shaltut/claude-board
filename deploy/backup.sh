#!/bin/sh
# A compressed dump of the board (pg_dump -Fc), kept CB_BACKUP_DAYS days (14). Prints the file it wrote.
# Nightly from root's crontab on the VPS:  15 3 * * * /opt/claude-board/deploy/backup.sh >> /var/log/claude-board-backup.log 2>&1
# Restore: docs/ops/maintain.md. The dumps hold everything on the board (client work included): keep them on the VPS
# or another machine of Ahmed's, never a shared drive.
set -eu
cd "$(dirname "$0")"
dir=${CB_BACKUP_DIR:-/var/backups/claude-board}
mkdir -p "$dir"
chmod 700 "$dir"
f="$dir/claude_board-$(date -u +%Y%m%dT%H%M%SZ).dump"
# a dump that fails half way never replaces a good one under the final name
docker compose exec -T db pg_dump -U cb -d claude_board -Fc > "$f.part"
mv "$f.part" "$f"
find "$dir" -name 'claude_board-*.dump' -mtime "+${CB_BACKUP_DAYS:-14}" -delete
echo "$f"
