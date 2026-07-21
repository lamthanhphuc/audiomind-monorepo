#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="infra/.env"
COMPOSE_FILES=(
  -f infra/docker-compose.dev.yml
  -f infra/docker-compose.mvp.yml
  -f infra/docker-compose.prod.yml
)
COMPOSE=(docker compose --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")

BACKUP_DIR="${BACKUP_DIR:-/opt/audiomind/backups}"
BACKUP_ID="${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
BACKUP_FILE="${BACKUP_FILE:-$BACKUP_DIR/audiomind-postgres-${BACKUP_ID}.dump}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOCK_FILE="${AUDIOMIND_BACKUP_LOCK_FILE:-/tmp/audiomind-backup.lock}"
MIN_AVAILABLE_KB="${AUDIOMIND_BACKUP_MIN_AVAILABLE_KB:-2097152}"
WARN_AVAILABLE_KB="${AUDIOMIND_BACKUP_WARN_AVAILABLE_KB:-5242880}"

tmp_file="${BACKUP_FILE}.tmp.$$"
sha_file="${BACKUP_FILE}.sha256"
sha_tmp="${sha_file}.tmp.$$"
lock_acquired=0

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -f "$tmp_file" "$sha_tmp"
}
trap cleanup EXIT

require_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    fail "$ENV_FILE is missing. Create it from infra/.env.production.example on the server."
  fi
}

validate_retention_days() {
  if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
    fail "RETENTION_DAYS must be a positive integer"
  fi
  if (( RETENTION_DAYS < 7 )) && [[ "${AUDIOMIND_BACKUP_FORCE_LOW_RETENTION:-0}" != "1" ]]; then
    fail "RETENTION_DAYS must be at least 7 unless AUDIOMIND_BACKUP_FORCE_LOW_RETENTION=1"
  fi
}

prepare_backup_dir() {
  mkdir -p "$BACKUP_DIR"
  chmod 750 "$BACKUP_DIR"
}

disk_preflight() {
  local available_kb

  available_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }')"
  if [[ -z "$available_kb" ]]; then
    fail "could not determine available disk for $BACKUP_DIR"
  fi

  if (( available_kb < MIN_AVAILABLE_KB )); then
    fail "available disk under $BACKUP_DIR is below 2 GB"
  fi
  if (( available_kb < WARN_AVAILABLE_KB )); then
    printf 'WARN: available disk under %s is below 5 GB.\n' "$BACKUP_DIR" >&2
  fi
}

acquire_lock() {
  if [[ "${AUDIOMIND_BACKUP_LOCK_HELD:-0}" == "1" ]]; then
    return 0
  fi
  command -v flock >/dev/null 2>&1 || fail "flock is required for backup locking"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    fail "another Audiomind backup is already running; lock=$LOCK_FILE"
  fi
  lock_acquired=1
}

cleanup_retention() {
  find "$BACKUP_DIR" -maxdepth 1 -type f \
    \( \
      -name 'audiomind-postgres-*.dump' -o \
      -name 'audiomind-postgres-*.dump.sha256' -o \
      -name 'audiomind-uploads-*.tar.gz' -o \
      -name 'audiomind-uploads-*.tar.gz.sha256' -o \
      -name 'audiomind-backup-manifest-*.json' \
    \) \
    -mtime +"$RETENTION_DAYS" \
    -print -delete
}

write_result_file() {
  local checksum="$1"
  local size_bytes="$2"

  if [[ -z "${AUDIOMIND_BACKUP_RESULT_FILE:-}" ]]; then
    return 0
  fi

  cat > "$AUDIOMIND_BACKUP_RESULT_FILE" <<EOF
type=postgres
path=$(basename "$BACKUP_FILE")
sha256=$checksum
size_bytes=$size_bytes
full_path=$BACKUP_FILE
sha_file=$sha_file
EOF
}

require_env_file
validate_retention_days
prepare_backup_dir
disk_preflight
acquire_lock

"${COMPOSE[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-privileges' > "$tmp_file"

if [[ ! -s "$tmp_file" ]]; then
  fail "Postgres backup temp file is missing or empty: $tmp_file"
fi

checksum="$(sha256sum "$tmp_file" | awk '{ print $1 }')"
[[ -n "$checksum" ]] || fail "could not compute sha256 for $tmp_file"

printf '%s  %s\n' "$checksum" "$(basename "$BACKUP_FILE")" > "$sha_tmp"
mv "$tmp_file" "$BACKUP_FILE"
mv "$sha_tmp" "$sha_file"

size_bytes="$(stat -c '%s' "$BACKUP_FILE")"
if [[ -z "$size_bytes" || "$size_bytes" == "0" ]]; then
  fail "Postgres backup file is missing or empty: $BACKUP_FILE"
fi

write_result_file "$checksum" "$size_bytes"
cleanup_retention

printf 'Wrote Postgres backup to %s\n' "$BACKUP_FILE"
printf 'Wrote Postgres backup checksum to %s\n' "$sha_file"
