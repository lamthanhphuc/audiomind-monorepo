#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ALLOWLIST="${ROOT_DIR}/scripts/ci/log-safety-allowlist.txt"
BASE="${LOG_SAFETY_BASE:-origin/main}"

FORBIDDEN=(
  "first16hex"
  "base64"
  "byte dump"
  "Authorization"
  "Bearer "
  "DEEPGRAM_API_KEY"
  "GEMINI_API_KEY"
  "raw transcript"
  "raw audio"
  "deviceId"
  "prompt text"
  "Gemini raw response"
  "groupedActionPlan"
  "grouped_action_plan"
)

is_allowlisted() {
  local file="$1"
  local line="$2"
  if [[ ! -f "$ALLOWLIST" ]]; then
    return 1
  fi
  while IFS= read -r rule || [[ -n "$rule" ]]; do
    [[ -z "$rule" || "$rule" =~ ^# ]] && continue
    if [[ "$file" == $rule* ]]; then
      return 0
    fi
    if [[ "$rule" == *:* ]]; then
      local prefix="${rule%%:*}"
      local needle="${rule#*:}"
      if [[ "$file" == "$prefix" && "$line" == *"$needle"* ]]; then
        return 0
      fi
    fi
  done < "$ALLOWLIST"
  return 1
}

is_logger_line() {
  local line="$1"
  [[ "$line" =~ log\.(info|warn|error|debug)\( ]] && return 0
  [[ "$line" =~ logger\.(info|warning|error|debug|bind)\( ]] && return 0
  [[ "$line" =~ console\.(log|warn|error)\( ]] && return 0
  return 1
}

collect_files() {
  local files
  if git rev-parse --verify "$BASE" >/dev/null 2>&1; then
    files="$(git diff --name-only "$BASE"...HEAD 2>/dev/null || true)"
  fi
  if [[ -z "$files" ]]; then
    files="$(git ls-files \
      'demoRecordAUDIOMID/**/*.java' \
      'demoRecordAUDIOMID/**/*.py' \
      'FE-Audiomind/src/**/*.ts' \
      'FE-Audiomind/src/**/*.tsx')"
  fi
  printf '%s\n' "$files" | while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    [[ "$file" != *.java && "$file" != *.py && "$file" != *.ts && "$file" != *.tsx ]] && continue
    [[ "$file" == *test* || "$file" == *Test* || "$file" == *.md ]] && continue
    printf '%s\n' "$file"
  done
}

violations=0

# shellcheck disable=SC2094
while IFS= read -r file; do
  [[ -z "$file" || ! -f "$file" ]] && continue
  line_no=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    is_logger_line "$line" || continue
    is_allowlisted "$file" "$line" && continue
    for token in "${FORBIDDEN[@]}"; do
      if [[ "$line" == *"$token"* ]]; then
        printf 'LOG_SAFETY_VIOLATION %s:%s contains forbidden %q\n' "$file" "$line_no" "$token"
        violations=$((violations + 1))
      fi
    done
  done < "$file"
done < <(collect_files)

if [[ "$violations" -gt 0 ]]; then
  printf 'log-safety-scan failed with %s violation(s)\n' "$violations" >&2
  exit 1
fi

printf 'log-safety-scan passed\n'
