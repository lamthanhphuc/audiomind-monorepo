#!/usr/bin/env bash
set -euo pipefail

NS="${K8S_NAMESPACE:-audiomind-staging}"
DRY_RUN=false

usage() {
  cat <<'EOF'
Usage: verify-ready-staging.sh [--dry-run]

Checks /ready on core APIs in K8s staging via kubectl port-forward.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

declare -A ENDPOINTS=(
  [meeting-api]=8081
  [processing-api]=8082
  [user-api]=8083
  [ai-api]=8000
)

if [[ "$DRY_RUN" == true ]]; then
  printf 'DRY_RUN verify-ready-staging namespace=%s\n' "$NS"
  for svc in "${!ENDPOINTS[@]}"; do
    port="${ENDPOINTS[$svc]}"
    printf '  would check http://127.0.0.1:%s/ready via svc/%s\n' "$port" "$svc"
  done
  exit 0
fi

if ! command -v kubectl >/dev/null 2>&1; then
  printf 'ERROR: kubectl not found\n' >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'ERROR: jq not found\n' >&2
  exit 1
fi

check_ready() {
  local svc="$1"
  local port="$2"
  local pf_pid
  local body
  local tmp

  tmp="$(mktemp)"
  kubectl port-forward -n "$NS" "svc/${svc}" "${port}:${port}" >"${tmp}.log" 2>&1 &
  pf_pid=$!
  trap 'kill '"$pf_pid"' 2>/dev/null || true; wait '"$pf_pid"' 2>/dev/null || true' RETURN

  for _ in $(seq 1 15); do
    if curl -fsS "http://127.0.0.1:${port}/ready" -o "$tmp" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if [[ ! -s "$tmp" ]]; then
    printf 'ERROR: %s /ready unreachable on port %s\n' "$svc" "$port" >&2
    cat "${tmp}.log" >&2 || true
    rm -f "$tmp" "${tmp}.log"
    return 1
  fi

  body="$(cat "$tmp")"
  printf '%s /ready => %s\n' "$svc" "$body"
  jq -e '.status == "UP"' <<<"$body" >/dev/null
  rm -f "$tmp" "${tmp}.log"
}

failed=0
for svc in meeting-api processing-api user-api ai-api; do
  port="${ENDPOINTS[$svc]}"
  if ! check_ready "$svc" "$port"; then
    failed=$((failed + 1))
  fi
done

if [[ "$failed" -gt 0 ]]; then
  printf 'verify-ready-staging failed (%s services)\n' "$failed" >&2
  exit 1
fi

printf 'verify-ready-staging passed for namespace %s\n' "$NS"
