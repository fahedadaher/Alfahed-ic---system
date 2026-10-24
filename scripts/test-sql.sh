#!/usr/bin/env bash
# Applies all migrations to a throwaway database on a plain Postgres
# (with a stub of Supabase's auth schema) and runs supabase/tests/*.test.sql.
#
#   PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres scripts/test-sql.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${TEST_DB:-alfahad_sql_test}"
PSQL=(psql -v ON_ERROR_STOP=1 -q -X -P pager=off -o /dev/null)

"${PSQL[@]}" -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null

run() { "${PSQL[@]}" -d "$DB" -f "$1" 2> >(grep -v -e 'wal_level' -e '^HINT' >&2); }

run supabase/tests/_supabase_stub.sql
for f in supabase/migrations/*.sql; do run "$f"; done
run supabase/seed.sql
for f in supabase/tests/*.test.sql; do echo "== $f"; run "$f"; done
echo "All SQL tests passed."
