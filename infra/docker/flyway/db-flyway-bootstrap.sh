#!/bin/sh
# One-shot Flyway history bootstrap for supported states only:
# 1) empty public schema -> baseline user + meeting history at version 0
# 2) both history tables already exist -> no-op
# Any partial/inconsistent state fails without repair.
set -eu

USER_HISTORY_TABLE="${FLYWAY_USER_TABLE:-flyway_schema_history_user}"
MEETING_HISTORY_TABLE="${FLYWAY_MEETING_TABLE:-flyway_schema_history_meeting}"

parse_jdbc_url() {
  url="${FLYWAY_URL#jdbc:postgresql://}"
  hostport="${url%%/*}"
  PGDATABASE="${url#*/}"
  PGDATABASE="${PGDATABASE%%\?*}"
  PGHOST="${hostport%%:*}"
  if [ "${hostport}" != "${PGHOST}" ]; then
    PGPORT="${hostport#*:}"
  else
    PGPORT="5432"
  fi
  PGUSER="${FLYWAY_USER}"
  PGPASSWORD="${FLYWAY_PASSWORD}"
  export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
}

psql_query() {
  PGPASSWORD="${PGPASSWORD}" psql \
    -h "${PGHOST}" \
    -p "${PGPORT}" \
    -U "${PGUSER}" \
    -d "${PGDATABASE}" \
    -v ON_ERROR_STOP=1 \
    -Atqc "$1"
}

parse_jdbc_url

user_exists="$(psql_query "SELECT CASE WHEN to_regclass('public.${USER_HISTORY_TABLE}') IS NULL THEN 0 ELSE 1 END;")"
meeting_exists="$(psql_query "SELECT CASE WHEN to_regclass('public.${MEETING_HISTORY_TABLE}') IS NULL THEN 0 ELSE 1 END;")"

if [ "${user_exists}" = "1" ] && [ "${meeting_exists}" = "1" ]; then
  echo "Both ${USER_HISTORY_TABLE} and ${MEETING_HISTORY_TABLE} exist; bootstrap is a no-op"
  exit 0
fi

if [ "${user_exists}" = "1" ] || [ "${meeting_exists}" = "1" ]; then
  echo "ERROR: partial Flyway history state (user=${user_exists}, meeting=${meeting_exists}); refusing to bootstrap or repair" >&2
  exit 1
fi

public_objects="$(psql_query "
SELECT
  (SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')
  + (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public')
  + (
      SELECT COUNT(*)
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM pg_class c WHERE c.reltype = t.oid OR c.reloftype = t.oid
        )
    );
")"

if [ "${public_objects}" != "0" ]; then
  echo "ERROR: public schema has ${public_objects} non-system object(s) but Flyway history is missing; refusing to bootstrap or repair" >&2
  exit 1
fi

echo "Empty public schema: baselining ${USER_HISTORY_TABLE} and ${MEETING_HISTORY_TABLE} at version 0"
flyway \
  -table="${USER_HISTORY_TABLE}" \
  -locations=filesystem:/flyway/sql \
  baseline \
  -baselineVersion=0 \
  -baselineDescription="Empty database bootstrap"

flyway \
  -table="${MEETING_HISTORY_TABLE}" \
  -locations=filesystem:/flyway/sql \
  baseline \
  -baselineVersion=0 \
  -baselineDescription="Empty database bootstrap"

echo "Flyway history bootstrap complete"
