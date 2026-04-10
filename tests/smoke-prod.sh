#!/usr/bin/env bash
set -euo pipefail

# Usage:
# BASE_URL="https://api.audiomind.example.com" ./tests/smoke-prod.sh
# This script is designed for staging/prod-like environments.

BASE_URL="${BASE_URL:-https://api.audiomind.example.com}"
EMAIL="${SMOKE_EMAIL:-smoke.user@example.com}"
PASSWORD="${SMOKE_PASSWORD:-ChangeMe123!}"
AUDIO_URL="${SMOKE_AUDIO_URL:-https://www2.cs.uic.edu/~i101/SoundFiles/StarWars60.wav}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

AUDIO_FILE="$TMP_DIR/sample.wav"
REGISTER_RESP="$TMP_DIR/register.json"
LOGIN_RESP="$TMP_DIR/login.json"
PROCESS_RESP="$TMP_DIR/process.json"

curl -fsSL "$AUDIO_URL" -o "$AUDIO_FILE"

echo "[smoke] register"
curl -fsS -X POST "$BASE_URL/api/users/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  -o "$REGISTER_RESP"

echo "[smoke] login"
curl -fsS -X POST "$BASE_URL/api/users/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" \
  -o "$LOGIN_RESP"

TOKEN="$(grep -o '"token"[[:space:]]*:[[:space:]]*"[^"]*"' "$LOGIN_RESP" | head -n1 | sed 's/.*:"\([^"]*\)"/\1/')"
if [[ -z "${TOKEN}" ]]; then
  echo "[smoke] ERROR: token not found in login response"
  cat "$LOGIN_RESP"
  exit 1
fi

echo "[smoke] processing"
curl -fsS -X POST "$BASE_URL/api/processing/upload-audio" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@$AUDIO_FILE" \
  -o "$PROCESS_RESP"

echo "[smoke] logout"
curl -fsS -X POST "$BASE_URL/api/users/logout" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' > /dev/null

echo "[smoke] success"
