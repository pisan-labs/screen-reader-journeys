#!/usr/bin/env bash
# Apply supabase/migrations to a throwaway local PostgreSQL, on a stub of the parts of Supabase
# they use (test/sql/supabase-stub.sql), twice (they must be idempotent), and check privileges,
# row-level security and the worker's functions, including two workers claiming at once.
#
# Needs PostgreSQL's server binaries (initdb, pg_ctl, postgres) and psql; set PG_BINDIR if they
# are not in /usr/lib/postgresql/<version>/bin. Run with: npm run test:sql
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
bindir=${PG_BINDIR:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1 || true)}
if [ -z "$bindir" ] || [ ! -x "$bindir/initdb" ]; then
  bindir=$(dirname "$(command -v initdb || echo /nonexistent/initdb)")
fi
if [ ! -x "$bindir/initdb" ] || ! command -v psql >/dev/null; then
  echo "test:sql needs PostgreSQL's initdb, pg_ctl and psql (set PG_BINDIR to their folder)." >&2
  exit 1
fi

work=$(mktemp -d)
port=$((20000 + RANDOM % 20000))
as=()
if [ "$(id -u)" = 0 ]; then
  # initdb refuses to run as root.
  chown postgres "$work"
  as=(runuser -u postgres --)
fi
cleanup() {
  "${as[@]}" "$bindir/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

"${as[@]}" "$bindir/initdb" -D "$work/data" -U postgres -A trust >/dev/null
"${as[@]}" "$bindir/pg_ctl" -D "$work/data" -l "$work/log" -w -o "-k $work -c listen_addresses='' -p $port" start >/dev/null
# Without the NOTICEs that an idempotent migration's second run prints ("already exists, skipping").
export PGOPTIONS="-c client_min_messages=warning"
psql=(psql -h "$work" -p "$port" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)

echo "PostgreSQL: $("${psql[@]}" -At -c 'show server_version')"
"${psql[@]}" -o /dev/null -f "$here/supabase-stub.sql"
for pass in first second; do
  for migration in "$root"/supabase/migrations/*.sql; do
    echo "applying $(basename "$migration") ($pass time)"
    "${psql[@]}" -o /dev/null -f "$migration"
  done
done
"${psql[@]}" -o /dev/null -f "$here/checks.sql"

echo "two workers claiming at once get different runs, and the second does not wait"
"${psql[@]}" -c "insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000000d', 'd@example.org')"
"${psql[@]}" -c "insert into app_screen_reader_journeys.runs (user_id, base_url, journeys, modes, created_at) values
  ('00000000-0000-4000-8000-00000000000d', 'https://one.vercel.app/', '{x}', '{walker}', now() - interval '2 minutes'),
  ('00000000-0000-4000-8000-00000000000b', 'https://two.vercel.app/', '{x}', '{walker}', now() - interval '1 minute')"
claim="begin; select test.act_as('anon'); select base_url from app_screen_reader_journeys.worker_claim_next_run(test.token());"
# The first worker claims and holds its transaction open for 3 seconds.
"${psql[@]}" -At -c "$claim select pg_sleep(3); commit;" | grep -v '^$' >"$work/first" &
sleep 1
start=$(date +%s%N)
second=$("${psql[@]}" -At -c "$claim commit;" | grep -v '^$' || true)
elapsed=$((($(date +%s%N) - start) / 1000000))
wait
first=$(cat "$work/first")
echo "  first: $first, second: $second, second took ${elapsed} ms"
[ "$first" = "https://one.vercel.app/" ] || { echo "the first worker should claim the older run" >&2; exit 1; }
[ "$second" = "https://two.vercel.app/" ] || { echo "the second worker should skip the locked run and claim the other" >&2; exit 1; }
[ "$elapsed" -lt 1500 ] || { echo "the second worker waited for the first (no SKIP LOCKED?)" >&2; exit 1; }
"${psql[@]}" -At -c "select test.check((select count(*) from app_screen_reader_journeys.runs where status = 'running' and base_url in ('https://one.vercel.app/', 'https://two.vercel.app/')) = 2, 'both claimed runs are running')" >/dev/null

echo "SQL checks passed"
