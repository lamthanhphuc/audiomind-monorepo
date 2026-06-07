#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-/opt/audiomind/backups}"
BACKUP_ID="${BACKUP_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
CREATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-audiomind-prod}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
LOCK_FILE="${AUDIOMIND_BACKUP_LOCK_FILE:-/tmp/audiomind-backup.lock}"
MANIFEST_FILE="$BACKUP_DIR/audiomind-backup-manifest-${BACKUP_ID}.json"
manifest_tmp="${MANIFEST_FILE}.tmp.$$"
postgres_result="$(mktemp)"
uploads_result="$(mktemp)"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  rm -f "$manifest_tmp" "$postgres_result" "$uploads_result"
}
trap cleanup EXIT

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
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

acquire_lock() {
  command -v flock >/dev/null 2>&1 || fail "flock is required for backup locking"
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    fail "another Audiomind backup is already running; lock=$LOCK_FILE"
  fi
}

read_result() {
  local prefix="$1"
  local result_file="$2"
  local key
  local value

  [[ -s "$result_file" ]] || fail "backup result file is missing or empty: $result_file"
  while IFS='=' read -r key value; do
    [[ -n "$key" ]] || continue
    printf -v "${prefix}_${key}" '%s' "$value"
  done < "$result_file"
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

validate_retention_days
prepare_backup_dir
acquire_lock

if ! AUDIOMIND_BACKUP_LOCK_HELD=1 \
  AUDIOMIND_BACKUP_RESULT_FILE="$postgres_result" \
  BACKUP_DIR="$BACKUP_DIR" \
  BACKUP_ID="$BACKUP_ID" \
  RETENTION_DAYS="$RETENTION_DAYS" \
  bash "$ROOT_DIR/scripts/deploy/backup-postgres.sh"; then
  fail "Postgres backup failed; uploads backup was not started"
fi

if ! AUDIOMIND_BACKUP_LOCK_HELD=1 \
  AUDIOMIND_BACKUP_RESULT_FILE="$uploads_result" \
  BACKUP_DIR="$BACKUP_DIR" \
  BACKUP_ID="$BACKUP_ID" \
  RETENTION_DAYS="$RETENTION_DAYS" \
  bash "$ROOT_DIR/scripts/deploy/backup-uploads.sh"; then
  fail "uploads backup failed after Postgres backup completed"
fi

read_result postgres "$postgres_result"
read_result uploads "$uploads_result"

cat > "$manifest_tmp" <<EOF
{
  "backup_id": "$(json_escape "$BACKUP_ID")",
  "created_at": "$(json_escape "$CREATED_AT")",
  "compose_project": "$(json_escape "$COMPOSE_PROJECT")",
  "backup_dir": "$(json_escape "$BACKUP_DIR")",
  "retention_days": $RETENTION_DAYS,
  "files": [
    {
      "type": "postgres",
      "path": "$(json_escape "$postgres_path")",
      "sha256": "$(json_escape "$postgres_sha256")",
      "size_bytes": $postgres_size_bytes
    },
    {
      "type": "uploads",
      "path": "$(json_escape "$uploads_path")",
      "sha256": "$(json_escape "$uploads_sha256")",
      "size_bytes": $uploads_size_bytes
    }
  ]
}
EOF

if [[ ! -s "$manifest_tmp" ]]; then
  fail "manifest temp file is missing or empty: $manifest_tmp"
fi

mv "$manifest_tmp" "$MANIFEST_FILE"
cleanup_retention

printf 'Wrote production backup manifest to %s\n' "$MANIFEST_FILE"
