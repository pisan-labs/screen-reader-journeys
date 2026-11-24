-- screen-reader-journeys, migration 0002: at most 10 runs a day per person.
--
-- With ALLOWED_TARGET_HOSTS="*", anyone signed in may point the worker at any public site. Besides
-- the 3 runs waiting or running (0001, limit_active_runs), a person may start at most 10 runs per
-- UTC day. They are counted in run_counts, which people can neither read nor change: counting
-- rows of runs would not do, since people may delete their own runs.
--
-- The error code is 53400, as for the 3-run limit, so the API answers 429 with the message.
-- Idempotent, like 0001: safe to apply again.

create table if not exists app_screen_reader_journeys.run_counts (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null,
  runs    integer not null check (runs between 1 and 1000),
  primary key (user_id, day)
);

comment on table app_screen_reader_journeys.run_counts is 'Runs each person started per UTC day, for the daily limit. Written only by limit_daily_runs(); kept two days; nobody reads it through the API.';

alter table app_screen_reader_journeys.run_counts enable row level security;

-- Nobody reads the counts through the API.
drop policy if exists run_counts_none on app_screen_reader_journeys.run_counts;
create policy run_counts_none on app_screen_reader_journeys.run_counts
  for select to authenticated
  using (false);

create or replace function app_screen_reader_journeys.limit_daily_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  today date := (pg_catalog.now() at time zone 'utc')::date;
  started integer;
begin
  -- An insert for someone else fails the policy anyway (see limit_active_runs).
  if new.user_id is distinct from (select auth.uid()) then
    return new;
  end if;
  -- runs_limit_active fires first (triggers fire in name order) and holds this person's lock
  -- until the end of the transaction, so two inserts at once are counted one after the other.
  insert into app_screen_reader_journeys.run_counts as c (user_id, day, runs)
  values (new.user_id, today, 1)
  on conflict (user_id, day) do update set runs = c.runs + 1
  returning c.runs into started;
  if started > 10 then
    -- The insert fails, and with it this count (and limit_active_runs's retention delete).
    raise exception 'You have started 10 runs today (UTC). Try again tomorrow.'
      using errcode = '53400';
  end if;
  -- Only today and yesterday are kept.
  delete from app_screen_reader_journeys.run_counts c
   where c.user_id = new.user_id and c.day < today - 1;
  return new;
end;
$$;

drop trigger if exists runs_limit_daily on app_screen_reader_journeys.runs;
create trigger runs_limit_daily
  before insert on app_screen_reader_journeys.runs
  for each row execute function app_screen_reader_journeys.limit_daily_runs();

revoke all on table app_screen_reader_journeys.run_counts from public, anon, authenticated;
revoke execute on function app_screen_reader_journeys.limit_daily_runs() from public, anon, authenticated;
