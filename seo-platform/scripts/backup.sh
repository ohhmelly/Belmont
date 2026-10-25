#!/usr/bin/env bash
# Backs up the two things that actually need backing up in this
# deployment (see docs/DEPLOYMENT.md "Persistent storage"):
#   1. The Postgres database (via pg_dump, through the running `postgres`
#      container — not a raw copy of the volume, which would require the
#      container to be stopped to be consistent).
#   2. The generated-report storage directory (app/storage/reports/),
#      which is written directly to the app container's filesystem, not
#      to Postgres.
#
# Run this from the seo-platform/ directory (next to docker-compose.yml),
# with the stack already up (`docker compose up -d`). Safe to run while
# the stack is live — pg_dump takes a consistent snapshot without
# blocking reads/writes, and the reports directory is only ever
# written-then-read-once-complete, never rewritten in place.
#
# Usage:
#   ./scripts/backup.sh [destination-dir]
#
# Defaults to ./backups/<timestamp>/ if no destination is given. Intended
# to be run by hand or from a daily cron entry on the Linux production
# host; see DEPLOYMENT.md for a cron example.

set -euo pipefail

cd "$(dirname "$0")/.."

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="${1:-backups/$TIMESTAMP}"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-seo-platform}"

mkdir -p "$DEST"
echo "Backing up to $DEST ..."

# --- 1. Postgres dump --------------------------------------------------
# Uses `docker compose exec` so this runs through the same container
# every time (correct Postgres version, no local pg_dump version
# mismatch), and -Fc (custom format) so it can be restored selectively
# or in parallel later, and compresses by default.
if ! docker compose ps postgres --status running >/dev/null 2>&1 || \
   [ -z "$(docker compose ps -q postgres 2>/dev/null)" ]; then
  echo "ERROR: the 'postgres' service is not running (docker compose up -d first)." >&2
  exit 1
fi

echo "  -> pg_dump (postgres)..."
docker compose exec -T postgres \
  pg_dump -U postgres -d seo_platform -Fc -f /tmp/seo_platform.dump
docker compose cp postgres:/tmp/seo_platform.dump "$DEST/seo_platform.dump"
docker compose exec -T postgres rm -f /tmp/seo_platform.dump
echo "     wrote $DEST/seo_platform.dump ($(du -h "$DEST/seo_platform.dump" | cut -f1))"

# --- 2. Report storage ---------------------------------------------------
# app/storage/reports/ holds generated PDF/HTML/CSV/JSON report files,
# written by the app process directly to disk, not stored in Postgres.
# This is a bind-mount-free directory on the HOST under app/storage when
# running outside Docker, or inside the app container's writable layer
# when running via docker compose (the compose file does not currently
# mount it as a named volume — see DEPLOYMENT.md's note on this). Back it
# up by copying straight out of the running container so this script
# works the same way regardless of how the app was started.
echo "  -> report storage (app/storage/reports)..."
if docker compose exec -T app test -d /app/storage/reports 2>/dev/null; then
  docker compose exec -T app tar -C /app/storage -czf - reports > "$DEST/reports.tar.gz"
  echo "     wrote $DEST/reports.tar.gz ($(du -h "$DEST/reports.tar.gz" | cut -f1))"
elif [ -d app/storage/reports ]; then
  # Fallback: running the app directly on the host (non-Docker dev mode).
  tar -C app/storage -czf "$DEST/reports.tar.gz" reports
  echo "     wrote $DEST/reports.tar.gz ($(du -h "$DEST/reports.tar.gz" | cut -f1)) [host filesystem, not container]"
else
  echo "     WARNING: no reports directory found in the app container or on the host — skipped." >&2
fi

echo "Backup complete: $DEST"
