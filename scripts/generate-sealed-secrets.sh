#!/usr/bin/env bash
# Seal audiomind app + DB secrets with kubeseal. Never prints plaintext secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_ENVIRONMENT="${TARGET_ENVIRONMENT:-staging}"
TARGET_NAMESPACE="${TARGET_NAMESPACE:-}"
if [[ -z "${TARGET_NAMESPACE}" ]]; then
  if [[ "${TARGET_ENVIRONMENT}" == "staging" ]]; then
    TARGET_NAMESPACE="audiomind-staging"
  else
    TARGET_NAMESPACE="audiomind"
  fi
fi

REQUIRED_APP_KEYS=(JWT_SECRET INTERNAL_SERVICE_TOKEN GEMINI_API_KEY)
REQUIRED_DB_KEYS=(MEETING_DATABASE_URL USER_DATABASE_URL AI_DATABASE_URL DB_USERNAME DB_PASSWORD)

PLACEHOLDER_PATTERNS=(
  'REPLACE_'
  'CHANGE_ME'
  'change-me'
  'changeme'
  'replace_me'
  'your-managed-db-host'
  'your_username'
  'your_password'
  'managed-db.example'
)

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "missing required env ${name}"
  fi
}

contains_placeholder() {
  local value="$1"
  local lowered
  lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  for token in "${PLACEHOLDER_PATTERNS[@]}"; do
    local token_lower
    token_lower="$(printf '%s' "$token" | tr '[:upper:]' '[:lower:]')"
    if [[ "$value" == *"$token"* ]] || [[ "$lowered" == *"$token_lower"* ]]; then
      return 0
    fi
  done
  return 1
}

validate_non_placeholder() {
  local name="$1"
  local value="$2"
  if contains_placeholder "$value"; then
    fail "${name} contains placeholder text"
  fi
}

validate_jwt_secret() {
  local value="${JWT_SECRET:-}"
  if ((${#value} < 32)); then
    fail "JWT_SECRET length ${#value} < 32"
  fi
  validate_non_placeholder JWT_SECRET "$value"
}

validate_java_db_url() {
  local name="$1"
  local url="$2"
  if [[ ! "$url" =~ ^jdbc:postgresql:// ]]; then
    fail "${name} must start with jdbc:postgresql://"
  fi
  if [[ "${TARGET_ENVIRONMENT}" == "staging" || "${TARGET_ENVIRONMENT}" == "prod" ]]; then
    local lowered
    lowered="$(printf '%s' "$url" | tr '[:upper:]' '[:lower:]')"
    if [[ "$lowered" != *sslmode=require* && "$lowered" != *sslmode=verify-full* ]]; then
      fail "${name} must include sslmode=require or sslmode=verify-full for ${TARGET_ENVIRONMENT}"
    fi
  fi
}

validate_ai_db_url() {
  local url="$1"
  if [[ "$url" == jdbc:* ]]; then
    fail "AI_DATABASE_URL must not be JDBC"
  fi
  if [[ "$url" == postgresql+psycopg://* ]] || [[ "$url" == postgresql+asyncpg://* ]]; then
    fail "AI_DATABASE_URL must use psycopg2 driver (postgresql:// or postgresql+psycopg2://)"
  fi
  if [[ ! "$url" =~ ^postgresql:// ]] && [[ ! "$url" =~ ^postgresql\+psycopg2:// ]]; then
    fail "AI_DATABASE_URL must start with postgresql:// or postgresql+psycopg2://"
  fi
  if [[ "${TARGET_ENVIRONMENT}" == "staging" || "${TARGET_ENVIRONMENT}" == "prod" ]]; then
    local lowered
    lowered="$(printf '%s' "$url" | tr '[:upper:]' '[:lower:]')"
    if [[ "$lowered" != *sslmode=require* && "$lowered" != *sslmode=verify-full* ]]; then
      fail "AI_DATABASE_URL must include sslmode=require or sslmode=verify-full for ${TARGET_ENVIRONMENT}"
    fi
  fi
}

validate_inputs() {
  [[ "${TARGET_ENVIRONMENT}" == "staging" || "${TARGET_ENVIRONMENT}" == "prod" ]] \
    || fail "TARGET_ENVIRONMENT must be staging or prod (got ${TARGET_ENVIRONMENT})"

  for key in "${REQUIRED_APP_KEYS[@]}"; do
    require_env "$key"
    validate_non_placeholder "$key" "${!key}"
  done
  validate_jwt_secret

  for key in "${REQUIRED_DB_KEYS[@]}"; do
    require_env "$key"
    validate_non_placeholder "$key" "${!key}"
  done

  validate_java_db_url MEETING_DATABASE_URL "${MEETING_DATABASE_URL}"
  validate_java_db_url USER_DATABASE_URL "${USER_DATABASE_URL}"
  validate_ai_db_url "${AI_DATABASE_URL}"
}

resolve_kubeseal_cert() {
  if [[ -n "${KUBESEAL_CERT:-}" ]]; then
    [[ -f "${KUBESEAL_CERT}" ]] || fail "KUBESEAL_CERT file not found: ${KUBESEAL_CERT}"
    printf '%s' "${KUBESEAL_CERT}"
    return
  fi
  if ! command -v kubeseal >/dev/null 2>&1; then
    fail "kubeseal not found in PATH"
  fi
  if ! command -v kubectl >/dev/null 2>&1; then
    fail "kubectl not found; set KUBESEAL_CERT or configure cluster access"
  fi
  local tmp
  tmp="$(mktemp)"
  if ! kubeseal --fetch-cert --namespace "${TARGET_NAMESPACE}" >"${tmp}" 2>/dev/null; then
    rm -f "${tmp}"
    fail "kubeseal --fetch-cert failed; set KUBESEAL_CERT to a controller cert file"
  fi
  printf '%s' "${tmp}"
}

write_secret_yaml() {
  local out="$1"
  local name="$2"
  shift 2
  local args=(kubectl create secret generic "${name}" --namespace="${TARGET_NAMESPACE}" --dry-run=client -o yaml)
  while (($#)); do
    args+=(--from-literal="$1=$2")
    shift 2
  done
  "${args[@]}" >"${out}"
  chmod 600 "${out}"
}

seal_secret() {
  local plaintext="$1"
  local out="$2"
  local cert_arg=()
  if [[ -n "${cert_file}" ]]; then
    cert_arg=(--cert "${cert_file}")
  fi
  if ! kubeseal "${cert_arg[@]}" --format yaml --namespace "${TARGET_NAMESPACE}" <"${plaintext}" >"${out}"; then
    fail "kubeseal failed for ${plaintext##*/}"
  fi
}

confirm_encrypted_keys() {
  local file="$1"
  shift
  local required=("$@")
  local missing=()
  for key in "${required[@]}"; do
    if ! grep -Eq "^[[:space:]]${key}:[[:space:]]" "${file}"; then
      missing+=("${key}")
    fi
  done
  ((${#missing[@} == 0)) || fail "${file} missing encryptedData keys: ${missing[*]}"
  if grep -q 'REPLACE_WITH_SEALED' "${file}"; then
    fail "${file} still contains REPLACE_WITH_SEALED placeholder ciphertext"
  fi
}

TMPDIR=""
cert_file=""
cert_is_temp=false

cleanup() {
  if [[ -n "${TMPDIR}" && -d "${TMPDIR}" ]]; then
    rm -rf "${TMPDIR}"
  fi
  if [[ "${cert_is_temp}" == true && -n "${cert_file}" && -f "${cert_file}" ]]; then
    rm -f "${cert_file}"
  fi
}
trap cleanup EXIT

validate_inputs

if ! command -v kubeseal >/dev/null 2>&1; then
  fail "kubeseal not found in PATH"
fi

TMPDIR="$(mktemp -d)"
chmod 700 "${TMPDIR}"

resolved_cert="$(resolve_kubeseal_cert)"
if [[ "${resolved_cert}" == "${KUBESEAL_CERT:-}" ]]; then
  cert_file="${resolved_cert}"
  cert_is_temp=false
else
  cert_file="${resolved_cert}"
  cert_is_temp=true
fi

OUT_DIR="${ROOT}/k8s/overlays/${TARGET_ENVIRONMENT}"
mkdir -p "${OUT_DIR}"
APP_PLAIN="${TMPDIR}/audiomind-secrets.yaml"
DB_PLAIN="${TMPDIR}/audiomind-db-secrets.yaml"
APP_SEALED="${OUT_DIR}/sealed-secret.generated.yaml"
DB_SEALED="${OUT_DIR}/sealed-db-secret.generated.yaml"

write_secret_yaml "${APP_PLAIN}" audiomind-secrets \
  JWT_SECRET "${JWT_SECRET}" \
  INTERNAL_SERVICE_TOKEN "${INTERNAL_SERVICE_TOKEN}" \
  GEMINI_API_KEY "${GEMINI_API_KEY}"

write_secret_yaml "${DB_PLAIN}" audiomind-db-secrets \
  MEETING_DATABASE_URL "${MEETING_DATABASE_URL}" \
  USER_DATABASE_URL "${USER_DATABASE_URL}" \
  AI_DATABASE_URL "${AI_DATABASE_URL}" \
  DB_USERNAME "${DB_USERNAME}" \
  DB_PASSWORD "${DB_PASSWORD}"

seal_secret "${APP_PLAIN}" "${APP_SEALED}"
seal_secret "${DB_PLAIN}" "${DB_SEALED}"

confirm_encrypted_keys "${APP_SEALED}" "${REQUIRED_APP_KEYS[@]}"
confirm_encrypted_keys "${DB_SEALED}" "${REQUIRED_DB_KEYS[@]}"

printf 'Sealed secrets written (no plaintext logged):\n'
printf '  %s\n' "${APP_SEALED}"
printf '  %s\n' "${DB_SEALED}"
printf 'Target namespace: %s\n' "${TARGET_NAMESPACE}"
