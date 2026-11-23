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
claim="select test.act_as('anon'); select base_url from app_screen_reader_journeys.worker_claim_next_run(test.token());"
# The first worker claims, then holds its transaction (and the row lock) open until it is told
# to stop: it sleeps in a loop that ends once the stop table has a row.
"${psql[@]}" -c "create table test.stop (at timestamptz); grant all on test.stop to public"
"${psql[@]}" -At -c "begin; $claim do \$\$ begin while not exists (select 1 from test.stop) loop perform pg_sleep(0.05); end loop; end \$\$; commit;" | grep -v '^$' >"$work/first" &
first_pid=$!
# Wait for the condition, not for a time: the first session has claimed (its claim is not
# committed, so only the row lock shows it) and sleeps in its loop.
until [ "$("${psql[@]}" -At -c "select count(*) from pg_stat_activity where wait_event = 'PgSleep' and query like '%test.stop%'")" = 1 ]; do
  kill -0 "$first_pid" 2>/dev/null || { echo "the first worker exited early" >&2; exit 1; }
  "${psql[@]}" -At -c "select pg_sleep(0.05)" >/dev/null
done
# The second worker may not wait for any lock: a wait would end in a lock_timeout error.
second=$("${psql[@]}" -At -c "begin; set local lock_timeout = '1ms'; $claim commit;" | grep -v '^$')
"${psql[@]}" -c "insert into test.stop values (now())"
wait "$first_pid"
first=$(cat "$work/first")
echo "  first: $first, second: $second"
[ "$first" = "https://one.vercel.app/" ] || { echo "the first worker should claim the older run" >&2; exit 1; }
[ "$second" = "https://two.vercel.app/" ] || { echo "the second worker should skip the locked run and claim the other" >&2; exit 1; }
"${psql[@]}" -At -c "select test.check((select count(*) from app_screen_reader_journeys.runs where status = 'running' and base_url in ('https://one.vercel.app/', 'https://two.vercel.app/')) = 2, 'both claimed runs are running')" >/dev/null

echo "SQL checks passed"
