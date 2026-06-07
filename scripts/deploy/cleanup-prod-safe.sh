#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

BACKUP_DIR="${BACKUP_DIR:-/opt/audiomind/backups}"
REDACTED_LOG_DIR="${REDACTED_LOG_DIR:-/opt/audiomind/audiomind-logs}"
OPS_LOG_DIR="${OPS_LOG_DIR:-/opt/audiomind/ops-logs}"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-14}"
MONITOR_RETENTION_DAYS="${MONITOR_RETENTION_DAYS:-14}"

apply=0
yes=0

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy/cleanup-prod-safe.sh
  bash scripts/deploy/cleanup-prod-safe.sh --apply
  bash scripts/deploy/cleanup-prod-safe.sh --apply --yes

Dry-run is the default. Actual deletion requires --apply --yes.
EOF
}

while (($#)); do
  case "$1" in
    --apply)
      apply=1
      ;;
    --yes)
      yes=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'ERROR: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

validate_retention_days() {
  local name="$1"
  local value="$2"

  if ! [[ "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    printf 'ERROR: %s must be an integer greater than or equal to 1.\n' "$name" >&2
    exit 1
  fi
}

validate_retention_days LOG_RETENTION_DAYS "$LOG_RETENTION_DAYS"
validate_retention_days MONITOR_RETENTION_DAYS "$MONITOR_RETENTION_DAYS"

section() {
  printf '\n== %s ==\n' "$*"
}

run_or_print() {
  local label="$1"
  shift

  if (( apply == 1 && yes == 1 )); then
    printf '+ %s\n' "$label"
    printf '  '
    printf ' %q' "$@"
    printf '\n'
    "$@"
  else
    printf 'DRY-RUN: %s\n' "$label"
  fi
}

show_disk_usage() {
  section "$1: df -h"
  df -h

  section "$1: docker system df"
  docker system df || true
}

show_backup_dir() {
  section "Backup Directory"
  du -sh "$BACKUP_DIR" 2>/dev/null || true
  ls -lh "$BACKUP_DIR" 2>/dev/null || true
}

cleanup_redacted_logs() {
  section "Old Redacted Log Bundles"
  if [[ ! -d "$REDACTED_LOG_DIR" ]]; then
    printf 'Log directory not found: %s\n' "$REDACTED_LOG_DIR"
    return 0
  fi

  if (( apply == 1 && yes == 1 )); then
    find "$REDACTED_LOG_DIR" -maxdepth 1 -type f \
      -name 'prod-logs-redacted-*.log' \
      -mtime +"$LOG_RETENTION_DAYS" \
      -print -delete
  else
    find "$REDACTED_LOG_DIR" -maxdepth 1 -type f \
      -name 'prod-logs-redacted-*.log' \
      -mtime +"$LOG_RETENTION_DAYS" \
      -print
  fi
}

cleanup_monitor_reports() {
  section "Old Monitor Reports"
  if [[ ! -d "$OPS_LOG_DIR" ]]; then
    printf 'Monitor report directory not found: %s\n' "$OPS_LOG_DIR"
    return 0
  fi

  if (( apply == 1 && yes == 1 )); then
    find "$OPS_LOG_DIR" -maxdepth 1 -type f \
      -name 'monitor-prod-*.log' \
      -mtime +"$MONITOR_RETENTION_DAYS" \
      -print -delete
  else
    find "$OPS_LOG_DIR" -maxdepth 1 -type f \
      -name 'monitor-prod-*.log' \
      -mtime +"$MONITOR_RETENTION_DAYS" \
      -print
  fi
}

section "Cleanup Mode"
if (( apply == 1 && yes == 1 )); then
  printf 'Mode: APPLY. Safe cleanup will run now.\n'
else
  printf 'Mode: DRY-RUN. No files, containers, images, cache, or logs will be deleted.\n'
  if (( apply == 1 && yes == 0 )); then
    printf 'WARN: --apply was provided without --yes, so cleanup remains dry-run.\n'
    printf 'To apply after reviewing output, run:\n'
    printf 'bash scripts/deploy/cleanup-prod-safe.sh --apply --yes\n'
  fi
fi

printf '\nBefore stronger cleanup, confirm the newest backup files and manifest exist.\n'
printf 'This script does not delete %s outside backup script retention.\n' "$BACKUP_DIR"

show_disk_usage "Before Cleanup"
show_backup_dir

section "Docker Cleanup"
run_or_print "docker builder prune --filter until=168h" \
  docker builder prune --force --filter "until=168h"
run_or_print "docker container prune --filter until=24h" \
  docker container prune --force --filter "until=24h"
run_or_print "docker image prune dangling only until=168h" \
  docker image prune --force --filter "dangling=true" --filter "until=168h"

cleanup_redacted_logs
cleanup_monitor_reports

section "Journal Cleanup"
printf 'Not running journal cleanup automatically because it may require sudo.\n'
printf 'Operator step if needed:\n'
printf 'sudo journalctl --vacuum-time=14d\n'

show_disk_usage "After Cleanup"
show_backup_dir

section "Post-Cleanup Validation"
printf 'Run these checks after reviewing cleanup output:\n'
printf 'df -h\n'
printf 'docker system df\n'
printf 'bash scripts/deploy/health-prod.sh\n'
