#!/bin/sh
set -eu

chown -R 10001:10001 /app/models /app/uploads /app/storage /app/logs 2>/dev/null || true

exec gosu app "$@"