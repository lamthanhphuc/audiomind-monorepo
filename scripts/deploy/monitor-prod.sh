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

OPS_LOG_DIR="${OPS_LOG_DIR:-/opt/audiomind/ops-logs}"
REPORT_RETENTION_DAYS="${REPORT_RETENTION_DAYS:-14}"
REPORT_ID="$(date -u +%Y%m%dT%H%M%SZ)"
REPORT_FILE="${REPORT_FILE:-$OPS_LOG_DIR/monitor-prod-${REPORT_ID}.log}"

WARN_ROOT_DISK_PERCENT="${WARN_ROOT_DISK_PERCENT:-80}"
FAIL_ROOT_DISK_PERCENT="${FAIL_ROOT_DISK_PERCENT:-90}"
WARN_RAM_AVAILABLE_MB="${WARN_RAM_AVAILABLE_MB:-700}"
FAIL_RAM_AVAILABLE_MB="${FAIL_RAM_AVAILABLE_MB:-300}"
WARN_SWAP_USED_MB="${WARN_SWAP_USED_MB:-512}"

status=0
health_status=0

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'ERROR: %s is missing. Create it from infra/.env.production.example on the server.\n' "$ENV_FILE" >&2
  exit 1
fi

mkdir -p "$OPS_LOG_DIR"
chmod 750 "$OPS_LOG_DIR"

exec > >(tee -a "$REPORT_FILE") 2>&1

section() {
  printf '\n== %s ==\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*"
}

fail_check() {
  printf 'ERROR: %s\n' "$*"
  status=1
}

run_report_command() {
  local label="$1"
  shift

  section "$label"
  if ! "$@"; then
    warn "$label failed"
    return 1
  fi
}

cleanup_report_retention() {
  section "Monitor Report Retention"
  printf 'Keeping monitor reports for %s days in %s\n' "$REPORT_RETENTION_DAYS" "$OPS_LOG_DIR"
  find "$OPS_LOG_DIR" -maxdepth 1 -type f -name 'monitor-prod-*.log' \
    -mtime +"$REPORT_RETENTION_DAYS" -print -delete || warn "monitor report retention cleanup failed"
}

git_value() {
  local fallback="$1"
  shift

  "$@" 2>/dev/null || printf '%s\n' "$fallback"
}

check_root_disk() {
  local used_percent

  section "Thresholds: Disk"
  used_percent="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
  if [[ -z "$used_percent" ]]; then
    warn "could not read root disk usage"
    return 0
  fi

  printf 'root filesystem used=%s%% warn>=%s%% fail>=%s%%\n' \
    "$used_percent" "$WARN_ROOT_DISK_PERCENT" "$FAIL_ROOT_DISK_PERCENT"

  if (( used_percent >= FAIL_ROOT_DISK_PERCENT )); then
    fail_check "root filesystem usage is at or above ${FAIL_ROOT_DISK_PERCENT}%"
  elif (( used_percent >= WARN_ROOT_DISK_PERCENT )); then
    warn "root filesystem usage is at or above ${WARN_ROOT_DISK_PERCENT}%"
  fi
}

check_memory_thresholds() {
  local mem_available_kb
  local mem_available_mb
  local swap_free_kb
  local swap_total_kb
  local swap_used_mb

  section "Thresholds: RAM And Swap"
  mem_available_kb="$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null || true)"
  swap_total_kb="$(awk '/^SwapTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || true)"
  swap_free_kb="$(awk '/^SwapFree:/ { print $2 }' /proc/meminfo 2>/dev/null || true)"

  if [[ -z "$mem_available_kb" ]]; then
    warn "could not read MemAvailable from /proc/meminfo"
  else
    mem_available_mb=$(( mem_available_kb / 1024 ))
    printf 'available RAM=%s MB warn<%s MB fail<%s MB\n' \
      "$mem_available_mb" "$WARN_RAM_AVAILABLE_MB" "$FAIL_RAM_AVAILABLE_MB"
    if (( mem_available_mb < FAIL_RAM_AVAILABLE_MB )); then
      fail_check "available RAM is below ${FAIL_RAM_AVAILABLE_MB} MB"
    elif (( mem_available_mb < WARN_RAM_AVAILABLE_MB )); then
      warn "available RAM is below ${WARN_RAM_AVAILABLE_MB} MB"
    fi
  fi

  if [[ -z "$swap_total_kb" || -z "$swap_free_kb" ]]; then
    warn "could not read swap totals from /proc/meminfo"
    return 0
  fi

  swap_used_mb=$(( (swap_total_kb - swap_free_kb) / 1024 ))
  printf 'swap used=%s MB warn>%s MB\n' "$swap_used_mb" "$WARN_SWAP_USED_MB"
  if (( swap_used_mb > WARN_SWAP_USED_MB )); then
    warn "swap used is greater than ${WARN_SWAP_USED_MB} MB"
  fi
}

inspect_compose_containers() {
  local container_id
  local -a container_ids
  local inspect_output
  local name
  local restart_count
  local state_exit_code
  local state_restarting
  local state_status

  section "Container Restart Counts"
  if ! mapfile -t container_ids < <("${COMPOSE[@]}" ps -q); then
    warn "could not list Compose container ids"
    return 0
  fi

  if (( ${#container_ids[@]} == 0 )); then
    warn "no Compose containers found"
    return 0
  fi

  for container_id in "${container_ids[@]}"; do
    [[ -n "$container_id" ]] || continue
    if ! inspect_output="$(docker inspect --format '{{.Name}} {{.RestartCount}} {{.State.Status}} {{.State.Restarting}} {{.State.ExitCode}}' "$container_id")"; then
      warn "could not inspect container $container_id"
      continue
    fi

    read -r name restart_count state_status state_restarting state_exit_code <<< "$inspect_output"
    printf '%s restart_count=%s status=%s restarting=%s exit=%s\n' \
      "$name" "$restart_count" "$state_status" "$state_restarting" "$state_exit_code"

    if [[ "$restart_count" =~ ^[0-9]+$ ]] && (( restart_count > 0 )); then
      warn "$name restart_count is greater than 0"
    fi
    if [[ "$state_restarting" == "true" ]]; then
      fail_check "$name is restarting"
    elif [[ "$state_status" != "running" ]]; then
      warn "$name status is $state_status"
    fi
  done
}

section "Monitor Report"
printf 'report_file=%s\n' "$REPORT_FILE"
printf 'created_at_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'hostname=%s\n' "$(hostname 2>/dev/null || printf 'unknown')"
printf 'git_branch=%s\n' "$(git_value unknown git branch --show-current)"
printf 'git_revision=%s\n' "$(git_value unknown git rev-parse --short HEAD)"

run_report_command "Memory: free -h" free -h || true
check_memory_thresholds

run_report_command "Disk: df -h" df -h || true
check_root_disk

run_report_command "Docker Disk: docker system df" docker system df || true
run_report_command "Compose Status: docker compose ps" "${COMPOSE[@]}" ps || true
run_report_command "Container Stats: docker stats --no-stream" docker stats --no-stream || true
inspect_compose_containers

section "Backup Directory"
du -sh /opt/audiomind/backups 2>/dev/null || true

section "Production Health"
if ! bash "$ROOT_DIR/scripts/deploy/health-prod.sh"; then
  health_status=1
  fail_check "health-prod.sh failed"
fi

cleanup_report_retention

if (( status != 0 || health_status != 0 )); then
  section "Failure Capture"
  printf 'Monitor detected a failure. Collect redacted logs with:\n'
  printf 'bash scripts/deploy/collect-prod-logs-redacted.sh\n'
  exit 1
fi

section "Monitor Result"
printf 'Production monitor checks completed.\n'
