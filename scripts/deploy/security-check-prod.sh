#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="infra/.env"
EXPECTED_CORS_ALLOWED_ORIGINS="https://app.audiomind.pro.vn"
WARN_DOCKER_BUILD_CACHE_MB="${WARN_DOCKER_BUILD_CACHE_MB:-6144}"

COMPOSE_FILES=(
  -f infra/docker-compose.dev.yml
  -f infra/docker-compose.mvp.yml
  -f infra/docker-compose.prod.yml
)
COMPOSE=(docker compose --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}")

required_env_keys=(
  APP_ENV
  DOMAIN_ROOT
  CORS_ALLOWED_ORIGINS
  POSTGRES_DB
  POSTGRES_USER
  POSTGRES_PASSWORD
  JWT_SECRET
  DEEPGRAM_API_KEY
  GEMINI_API_KEY
  STT_PROVIDER
  ANALYSIS_PROVIDER
  AI_PROVIDER
  LOCAL_WHISPER_ENABLED
  ALLOW_LEGACY_LOCAL_STT
  OLLAMA_ENABLED
  ALLOW_LEGACY_LOCAL_AI
  VITE_MEETING_API_BASE_URL
  VITE_PROCESSING_API_BASE_URL
  VITE_USER_API_BASE_URL
  VITE_API_BASE
  VITE_API_CPU_BASE
  VITE_API_GPU_BASE
  VITE_AI_SERVICE_URL
  VITE_REALTIME_WS_ENABLED
  VITE_REALTIME_WS_BASE_URL
  WEB_BIND_ADDRESS
  MEETING_API_BIND_ADDRESS
  PROCESSING_API_BIND_ADDRESS
  USER_API_BIND_ADDRESS
)

allow_empty_env_keys=(
  VITE_AI_SERVICE_URL
)

literal_public_url_keys=(
  CORS_ALLOWED_ORIGINS
  VITE_MEETING_API_BASE_URL
  VITE_PROCESSING_API_BASE_URL
  VITE_USER_API_BASE_URL
  VITE_API_BASE
  VITE_REALTIME_WS_BASE_URL
)

fail_count=0
warn_count=0
pass_count=0
info_count=0

section() {
  printf '\n== %s ==\n' "$*"
}

pass() {
  printf 'PASS: %s\n' "$*"
  pass_count=$((pass_count + 1))
}

warn() {
  printf 'WARN: %s\n' "$*"
  warn_count=$((warn_count + 1))
}

fail_check() {
  printf 'FAIL: %s\n' "$*"
  fail_count=$((fail_count + 1))
}

info() {
  printf 'INFO: %s\n' "$*"
  info_count=$((info_count + 1))
}

allows_empty_value() {
  local key="$1"
  local allowed

  for allowed in "${allow_empty_env_keys[@]}"; do
    [[ "$key" == "$allowed" ]] && return 0
  done

  return 1
}

requires_literal_public_url() {
  local key="$1"
  local required

  for required in "${literal_public_url_keys[@]}"; do
    [[ "$key" == "$required" ]] && return 0
  done

  return 1
}

trim_value() {
  local value="$1"

  value="${value%$'\r'}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"

  if [[ "${#value}" -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi

  printf '%s\n' "$value"
}

env_value() {
  local key="$1"
  local line
  local value

  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  value="${line#*=}"
  trim_value "$value"
}

env_key_exists() {
  local key="$1"
  grep -Eq "^[[:space:]]*${key}=" "$ENV_FILE"
}

is_placeholder_value() {
  local value="$1"
  local lowered

  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  [[ "$lowered" == replace-with-* ]] && return 0
  [[ "$lowered" == *example.com* ]] && return 0
  [[ "$lowered" == *"<"* || "$lowered" == *">"* ]] && return 0
  [[ "$lowered" == *changeme* || "$lowered" == *change-me* ]] && return 0
  [[ "$lowered" == *placeholder* || "$lowered" == *todo* ]] && return 0
  return 1
}

assert_env_equals() {
  local key="$1"
  local expected="$2"
  local label="$3"
  local value

  value="$(env_value "$key" || true)"
  if [[ "$value" == "$expected" ]]; then
    pass "$label"
  else
    fail_check "$label"
  fi
}

check_required_files() {
  local required_files
  local path

  section "Required Files"
  required_files=(
    "$ENV_FILE"
    infra/.env.production.example
    infra/Caddyfile.example
    infra/docker-compose.dev.yml
    infra/docker-compose.mvp.yml
    infra/docker-compose.prod.yml
    scripts/deploy/health-prod.sh
    scripts/deploy/monitor-prod.sh
    scripts/deploy/collect-prod-logs-redacted.sh
    scripts/deploy/cleanup-prod-safe.sh
  )

  for path in "${required_files[@]}"; do
    if [[ -f "$path" ]]; then
      pass "found $path"
    else
      fail_check "missing required file: $path"
    fi
  done
}

check_env_file() {
  local key
  local value

  section "Production Env"
  if [[ ! -f "$ENV_FILE" ]]; then
    fail_check "$ENV_FILE is missing. Create it from infra/.env.production.example on the VPS."
    return 0
  fi

  pass "$ENV_FILE exists"

  for key in "${required_env_keys[@]}"; do
    if ! env_key_exists "$key"; then
      fail_check "required env key is missing: $key"
      continue
    fi

    value="$(env_value "$key" || true)"
    if [[ -z "$value" ]]; then
      if allows_empty_value "$key"; then
        pass "required env key exists and is intentionally empty: $key"
      else
        fail_check "required env key is missing or empty: $key"
      fi
      continue
    fi
    if is_placeholder_value "$value"; then
      fail_check "placeholder value remains for required env key: $key"
      continue
    fi
    if requires_literal_public_url "$key" && [[ "$value" == *'$'* || "$value" == *'${'* || "$value" == *'}'* ]]; then
      fail_check "public URL env key must be literal, not nested env reference: $key"
      continue
    fi
    pass "required env key is set without a placeholder: $key"
  done
}

check_cors() {
  local cors_value
  local lowered

  section "CORS"
  [[ -f "$ENV_FILE" ]] || return 0

  cors_value="$(env_value CORS_ALLOWED_ORIGINS || true)"
  lowered="$(printf '%s' "$cors_value" | tr '[:upper:]' '[:lower:]')"

  if [[ -z "$cors_value" ]]; then
    fail_check "CORS_ALLOWED_ORIGINS is empty"
    return 0
  fi

  if [[ "$lowered" == *localhost* || "$lowered" == *127.0.0.1* || "$cors_value" == *"*"* ]]; then
    fail_check "production CORS contains localhost, 127.0.0.1, or wildcard"
  else
    pass "production CORS does not contain localhost, 127.0.0.1, or wildcard"
  fi

  if [[ "$cors_value" == "$EXPECTED_CORS_ALLOWED_ORIGINS" ]]; then
    pass "production CORS exactly matches $EXPECTED_CORS_ALLOWED_ORIGINS"
  else
    fail_check "production CORS must exactly match $EXPECTED_CORS_ALLOWED_ORIGINS"
  fi
}

check_runtime_flags() {
  local compose_profiles

  section "Providers And Legacy Runtime"
  [[ -f "$ENV_FILE" ]] || return 0

  assert_env_equals APP_ENV production "APP_ENV is production in infra/.env"
  assert_env_equals STT_PROVIDER deepgram "Deepgram is the production STT provider"
  assert_env_equals ANALYSIS_PROVIDER gemini "Gemini is the production analysis provider"
  assert_env_equals AI_PROVIDER gemini "Gemini is the production AI provider"
  assert_env_equals LOCAL_WHISPER_ENABLED false "LOCAL_WHISPER_ENABLED is false"
  assert_env_equals ALLOW_LEGACY_LOCAL_STT false "ALLOW_LEGACY_LOCAL_STT is false"
  assert_env_equals OLLAMA_ENABLED false "OLLAMA_ENABLED is false"
  assert_env_equals ALLOW_LEGACY_LOCAL_AI false "ALLOW_LEGACY_LOCAL_AI is false"

  compose_profiles="$(env_value COMPOSE_PROFILES || true)"
  if [[ "$compose_profiles" == *legacy-offline* ]]; then
    fail_check "COMPOSE_PROFILES enables legacy-offline"
  else
    pass "legacy-offline profile is not enabled by infra/.env"
  fi
}

check_env_tracking() {
  section "Git Secret Hygiene"
  if ! command -v git >/dev/null 2>&1; then
    warn "git is not available, cannot verify whether $ENV_FILE is tracked"
    return 0
  fi

  if git ls-files --error-unmatch "$ENV_FILE" >/dev/null 2>&1; then
    fail_check "$ENV_FILE is tracked by git"
  else
    pass "$ENV_FILE is not tracked by git"
  fi
}

record_compose_audit_line() {
  local line="$1"
  case "$line" in
    PASS:*)
      pass "${line#PASS: }"
      ;;
    WARN:*)
      warn "${line#WARN: }"
      ;;
    FAIL:*)
      fail_check "${line#FAIL: }"
      ;;
    INFO:*)
      info "${line#INFO: }"
      ;;
    *)
      [[ -z "$line" ]] || warn "unrecognized Compose audit output"
      ;;
  esac
}

check_compose_render() {
  local compose_json
  local parse_output

  section "Rendered Compose"
  if [[ ! -f "$ENV_FILE" ]]; then
    fail_check "cannot render production Compose config without $ENV_FILE"
    return 0
  fi

  if ! command -v docker >/dev/null 2>&1; then
    fail_check "docker is not available, cannot render production Compose config"
    return 0
  fi

  if ! "${COMPOSE[@]}" config --quiet >/dev/null 2>&1; then
    fail_check "production Compose config did not render cleanly"
    return 0
  fi
  pass "production Compose config renders cleanly"

  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 is unavailable, skipping structured Compose port/env audit"
    return 0
  fi

  compose_json="$("${COMPOSE[@]}" config --format json 2>/dev/null || true)"
  if [[ -z "$compose_json" ]]; then
    fail_check "could not render production Compose config as JSON for safe field audit"
    return 0
  fi

  if ! parse_output="$(printf '%s\n' "$compose_json" | python3 -c '
import json
import sys

expected_cors = sys.argv[1]

try:
    data = json.load(sys.stdin)
except Exception:
    print("FAIL: could not parse rendered Compose JSON")
    sys.exit(0)

services = data.get("services") or {}
internal_services = ("db", "redis", "ai-api", "celery-worker")
public_services = ("web", "meeting-api", "processing-api", "user-api")
provider_services = ("ai-api", "celery-worker")
api_services = ("meeting-api", "processing-api", "user-api", "ai-api", "celery-worker")


def environment_for(service):
    env = (services.get(service) or {}).get("environment") or {}
    if isinstance(env, dict):
        return {str(k): "" if v is None else str(v) for k, v in env.items()}
    parsed = {}
    if isinstance(env, list):
        for item in env:
            text = str(item)
            if "=" in text:
                key, value = text.split("=", 1)
                parsed[key] = value
    return parsed


def port_summary(port):
    host_ip = str(port.get("host_ip") or port.get("hostIP") or "")
    published = str(port.get("published") or "")
    target = str(port.get("target") or "")
    protocol = str(port.get("protocol") or "tcp")
    if not host_ip:
        host_ip = "0.0.0.0"
    return host_ip, published, target, protocol


for service in internal_services:
    ports = (services.get(service) or {}).get("ports") or []
    if ports:
        print(f"FAIL: internal service {service} publishes {len(ports)} host port binding(s)")
    else:
        print(f"PASS: internal service {service} publishes no host ports")

for service in public_services:
    ports = (services.get(service) or {}).get("ports") or []
    if not ports:
        print(f"FAIL: public app service {service} has no loopback host binding for Caddy")
        continue
    bad = False
    for port in ports:
        host_ip, published, target, protocol = port_summary(port)
        print(f"INFO: {service} bind {host_ip}:{published}->{target}/{protocol}")
        if host_ip != "127.0.0.1":
            bad = True
    if bad:
        print(f"FAIL: public app service {service} is not bound only to 127.0.0.1")
    else:
        print(f"PASS: public app service {service} is bound to 127.0.0.1")

for service in provider_services:
    env = environment_for(service)
    if env.get("APP_ENV") == "production":
        print(f"PASS: {service} rendered APP_ENV is production")
    else:
        print(f"FAIL: {service} rendered APP_ENV is not production")

    expected = {
        "STT_PROVIDER": "deepgram",
        "ANALYSIS_PROVIDER": "gemini",
        "AI_PROVIDER": "gemini",
        "LOCAL_WHISPER_ENABLED": "false",
        "ALLOW_LEGACY_LOCAL_STT": "false",
        "OLLAMA_ENABLED": "false",
        "ALLOW_LEGACY_LOCAL_AI": "false",
    }
    for key, expected_value in expected.items():
        if env.get(key) == expected_value:
            print(f"PASS: {service} rendered {key} is {expected_value}")
        else:
            print(f"FAIL: {service} rendered {key} is not {expected_value}")

for service in api_services:
    env = environment_for(service)
    cors = env.get("CORS_ALLOWED_ORIGINS")
    if cors == expected_cors:
        print(f"PASS: {service} rendered CORS_ALLOWED_ORIGINS matches production origin")
    else:
        print(f"FAIL: {service} rendered CORS_ALLOWED_ORIGINS does not match production origin")
' "$EXPECTED_CORS_ALLOWED_ORIGINS" 2>/dev/null)"; then
    fail_check "could not parse rendered Compose JSON with python3"
    return 0
  fi

  while IFS= read -r line; do
    record_compose_audit_line "$line"
  done <<< "$parse_output"
}

check_health_script() {
  section "Production Health Script"
  if [[ ! -f scripts/deploy/health-prod.sh ]]; then
    fail_check "scripts/deploy/health-prod.sh is missing"
    return 0
  fi

  if bash scripts/deploy/health-prod.sh >/dev/null 2>&1; then
    pass "health-prod.sh passed"
  else
    fail_check "health-prod.sh failed"
  fi
}

check_ufw() {
  local status_output

  section "Firewall"
  if ! command -v ufw >/dev/null 2>&1; then
    warn "UFW is not installed or not on PATH; provider firewall may still be in use"
    return 0
  fi

  status_output="$(ufw status 2>/dev/null || true)"
  if printf '%s\n' "$status_output" | grep -qi '^Status:[[:space:]]*active'; then
    pass "UFW status is active"
  else
    warn "UFW status is missing or inactive; confirm provider firewall allows only 22, 80, and 443"
  fi
}

size_to_mb() {
  local raw="$1"
  local number
  local unit

  raw="${raw%% *}"
  number="$(printf '%s' "$raw" | sed -E 's/^([0-9.]+).*/\1/')"
  unit="$(printf '%s' "$raw" | sed -E 's/^[0-9.]+//; s/B$//; s/i$//')"

  if [[ -z "$number" ]]; then
    printf '0\n'
    return 0
  fi

  awk -v n="$number" -v u="$unit" '
    BEGIN {
      if (u == "k" || u == "K" || u == "KB" || u == "kB") {
        printf "%.0f\n", n / 1024
      } else if (u == "M" || u == "MB") {
        printf "%.0f\n", n
      } else if (u == "G" || u == "GB") {
        printf "%.0f\n", n * 1024
      } else if (u == "T" || u == "TB") {
        printf "%.0f\n", n * 1024 * 1024
      } else {
        printf "%.0f\n", n / 1024 / 1024
      }
    }
  '
}

check_docker_build_cache() {
  local df_output
  local cache_line
  local cache_size
  local reclaimable
  local reclaimable_mb

  section "Docker Build Cache"
  if ! command -v docker >/dev/null 2>&1; then
    warn "docker is not available, cannot report Docker build cache size"
    return 0
  fi

  df_output="$(docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null || true)"
  cache_line="$(printf '%s\n' "$df_output" | awk -F'|' '$1 == "Build Cache" { print; exit }')"
  if [[ -z "$cache_line" ]]; then
    warn "could not read Docker build cache size"
    return 0
  fi

  cache_size="$(printf '%s' "$cache_line" | awk -F'|' '{ print $2 }')"
  reclaimable="$(printf '%s' "$cache_line" | awk -F'|' '{ print $3 }')"
  reclaimable_mb="$(size_to_mb "$reclaimable")"

  info "Docker build cache size is ${cache_size}; reclaimable is ${reclaimable}"
  if [[ "$reclaimable_mb" =~ ^[0-9]+$ ]] && (( reclaimable_mb >= WARN_DOCKER_BUILD_CACHE_MB )); then
    warn "Docker build cache reclaimable size is at or above ${WARN_DOCKER_BUILD_CACHE_MB} MB"
  else
    pass "Docker build cache reclaimable size is below ${WARN_DOCKER_BUILD_CACHE_MB} MB"
  fi
}

first_grep_value() {
  local pattern="$1"
  local path="$2"

  [[ -f "$path" ]] || return 0
  grep -E "$pattern" "$path" 2>/dev/null | head -n 1 | sed -E 's/^[[:space:]]*//' || true
}

check_upload_limits() {
  local caddy_limit
  local meeting_limit
  local meeting_request_limit
  local processing_limit
  local processing_request_limit
  local ai_limit
  local ui_hint

  section "Upload Limit Baseline"
  caddy_limit="$(awk '/request_body[[:space:]]*\{/ { in_body = 1 } in_body && /max_size/ { print $2; exit } in_body && /\}/ { in_body = 0 }' infra/Caddyfile.example 2>/dev/null || true)"
  meeting_limit="$(first_grep_value 'max-file-size:' demoRecordAUDIOMID/meeting-service/src/main/resources/application.yml)"
  meeting_request_limit="$(first_grep_value 'max-request-size:' demoRecordAUDIOMID/meeting-service/src/main/resources/application.yml)"
  processing_limit="$(first_grep_value 'max-file-size:' demoRecordAUDIOMID/processing-service/src/main/resources/application.yml)"
  processing_request_limit="$(first_grep_value 'max-request-size:' demoRecordAUDIOMID/processing-service/src/main/resources/application.yml)"
  ai_limit="$(first_grep_value 'max_upload_size_bytes:' demoRecordAUDIOMID/ai-service/app/config.py)"
  ui_hint="$(grep -E 'upload-subtext|Supported formats|accept=' FE-Audiomind/src/components/features/FeatureUpload.tsx 2>/dev/null | head -n 2 | sed -E 's/^[[:space:]]*//' | tr '\n' ' ' || true)"

  if [[ -n "$caddy_limit" ]]; then
    info "Caddyfile.example processing request_body max_size: $caddy_limit"
  else
    warn "Caddyfile.example upload max_size not found"
  fi
  if [[ -n "$meeting_limit" ]]; then
    info "meeting-service multipart $meeting_limit"
  fi
  if [[ -n "$meeting_request_limit" ]]; then
    info "meeting-service multipart $meeting_request_limit"
  fi
  if [[ -n "$processing_limit" ]]; then
    info "processing-service multipart $processing_limit"
  fi
  if [[ -n "$processing_request_limit" ]]; then
    info "processing-service multipart $processing_request_limit"
  fi
  if [[ -n "$ai_limit" ]]; then
    info "ai-service $ai_limit"
  fi
  if [[ -n "$ui_hint" ]]; then
    info "frontend upload UI includes a format hint or accept attribute"
  fi

  warn "upload limits are reported only; canonical production upload policy belongs to 7T-Security-D"
}

check_caddy_template() {
  local caddy_file="infra/Caddyfile.example"
  local missing_headers=()

  section "Caddy Template"
  if [[ ! -f "$caddy_file" ]]; then
    fail_check "$caddy_file is missing"
    return 0
  fi

  grep -q 'Strict-Transport-Security' "$caddy_file" || missing_headers+=("Strict-Transport-Security")
  grep -q 'X-Content-Type-Options' "$caddy_file" || missing_headers+=("X-Content-Type-Options")
  if ! grep -q 'X-Frame-Options' "$caddy_file" && ! grep -q 'frame-ancestors' "$caddy_file"; then
    missing_headers+=("X-Frame-Options/frame-ancestors")
  fi
  grep -q 'Referrer-Policy' "$caddy_file" || missing_headers+=("Referrer-Policy")
  grep -q 'Permissions-Policy' "$caddy_file" || missing_headers+=("Permissions-Policy")

  if (( ${#missing_headers[@]} == 0 )); then
    pass "Caddyfile.example includes baseline security headers"
  else
    warn "Caddyfile.example is missing security header template entries: ${missing_headers[*]}"
  fi

  if grep -Eq '\\.git|/\\.git|wp-admin|wp-login|phpmyadmin|/\\.env' "$caddy_file"; then
    pass "Caddyfile.example includes common bot scan path blocks"
  else
    warn "Caddyfile.example has no common bot scan path block template"
  fi
}

check_spring_warning_baseline() {
  section "Spring Warning Baseline"
  if grep -R "spring.jpa.open-in-view" demoRecordAUDIOMID/meeting-service/src/main/resources demoRecordAUDIOMID/user-service/src/main/resources >/dev/null 2>&1; then
    pass "spring.jpa.open-in-view is explicitly configured in Spring service resources"
  else
    warn "Spring open-in-view warning cleanup appears to remain"
  fi

  if grep -R "PostgreSQLDialect" demoRecordAUDIOMID/meeting-service/src/main/resources demoRecordAUDIOMID/user-service/src/main/resources infra/docker-compose.dev.yml >/dev/null 2>&1; then
    warn "explicit PostgreSQLDialect config remains for later warning cleanup"
  else
    pass "explicit PostgreSQLDialect config was not found in targeted Spring config"
  fi
}

report_public_domains() {
  local key
  local value

  section "Public Domain Summary"
  for key in APP_DOMAIN MEETING_DOMAIN PROCESSING_DOMAIN USER_DOMAIN PUBLIC_FRONTEND_ORIGIN PUBLIC_MEETING_API_ORIGIN PUBLIC_PROCESSING_API_ORIGIN PUBLIC_USER_API_ORIGIN; do
    value="$(env_value "$key" || true)"
    if [[ -n "$value" ]]; then
      info "$key is configured"
    fi
  done
}

report_monitor_backup_summary() {
  section "Monitor And Backup Summary"
  if [[ -f scripts/deploy/monitor-prod.sh ]]; then
    pass "monitor-prod.sh is present for production resource and health checks"
  else
    fail_check "monitor-prod.sh is missing"
  fi

  if [[ -f scripts/deploy/cleanup-prod-safe.sh ]]; then
    info "cleanup-prod-safe.sh is dry-run by default and can report Docker cleanup opportunities"
  else
    warn "cleanup-prod-safe.sh is missing"
  fi

  if [[ -d /opt/audiomind/backups ]]; then
    info "backup directory exists at /opt/audiomind/backups"
  else
    info "backup directory /opt/audiomind/backups was not found from this checkout"
  fi
}

section "Audit Mode"
info "security-check-prod.sh is audit-only. It does not change firewall, Caddy, SSH, env files, Docker containers, or app config."
info "full rendered Docker Compose config will not be printed because it can contain secrets."

check_required_files
check_env_file
check_cors
check_runtime_flags
check_env_tracking
report_public_domains
check_compose_render
check_health_script
check_ufw
check_docker_build_cache
check_upload_limits
check_caddy_template
check_spring_warning_baseline
report_monitor_backup_summary

section "Audit Summary"
printf 'PASS=%s WARN=%s FAIL=%s INFO=%s\n' "$pass_count" "$warn_count" "$fail_count" "$info_count"

if (( fail_count > 0 )); then
  printf 'Result: FAIL. Review FAIL items before production hardening.\n'
  exit 1
fi

if (( warn_count > 0 )); then
  printf 'Result: PASS with WARN items. Review warnings before the next security slice.\n'
else
  printf 'Result: PASS.\n'
fi
