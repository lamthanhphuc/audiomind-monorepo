#!/bin/sh
set -eu

chown -R 10001:10001 /app/uploads /app 2>/dev/null || true

exec gosu app "$@"