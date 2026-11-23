-- Runs of screen reader journeys, their results, and the private bucket for their reports.
--
-- Who may do what:
--   signed-in users  read their own runs and results, and queue new runs (status 'queued' only,
--                    at most 3 waiting or running at once); read the report files of their own runs
--   service role     everything (the server's worker): claims runs, updates them, writes results
--                    and uploads reports
--   anonymous        nothing

-- Runs -------------------------------------------------------------------------------------

create table public.runs (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  base_url    text not null check (char_length(base_url) <= 2048 and base_url ~ '^https?://'),
  -- Repo-relative journey paths, e.g. 'targets/generic/home-tab-order.journey.js'. The server
  -- checks them against its own targets/ again before running.
  journeys    text[] not null check (cardinality(journeys) between 1 and 100),
  -- The server runs only walker and virtual; voiceover needs a Mac.
  modes       text[] not null check (cardinality(modes) between 1 and 2 and modes <@ array['walker', 'virtual']),
  status      text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  error       text,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  summary     jsonb
);

comment on table public.runs is 'Screen reader journey runs. Users queue them; the server''s worker runs them.';

-- The queue (claim_next_run) and each user's list of runs.
create index runs_queued_idx on public.runs (created_at) where status = 'queued';
create index runs_created_by_idx on public.runs (created_by, created_at desc);

-- Results: one row per journey and mode ----------------------------------------------------

create table public.run_results (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references public.runs (id) on delete cascade,
  journey       text not null,
  mode          text not null,
  status        text not null check (status in ('pass', 'fail', 'error')),
  checks_passed integer not null default 0 check (checks_passed >= 0),
  checks_total  integer not null default 0 check (checks_total >= 0),
  errors        integer not null default 0 check (errors >= 0),
  warnings      integer not null default 0 check (warnings >= 0),
  -- The Markdown report in the 'reports' bucket: '<run_id>/<journey>.<mode>.md'.
  report_path   text
);

create index run_results_run_id_idx on public.run_results (run_id);

-- Privileges -------------------------------------------------------------------------------
-- Supabase grants everything on new tables to anon and authenticated; take that back and
-- grant only what the policies below need. Users may set only these columns when queueing a
-- run, so they cannot choose its id, timestamps (and so its place in the queue), error or summary.

revoke all on table public.runs, public.run_results from anon, authenticated;
grant select on table public.runs, public.run_results to authenticated;
grant insert (created_by, base_url, journeys, modes, status) on table public.runs to authenticated;
grant all on table public.runs, public.run_results to service_role;

-- Row-level security -----------------------------------------------------------------------
-- No update or delete policies: only the service role, which bypasses RLS, changes rows.

alter table public.runs enable row level security;
alter table public.run_results enable row level security;

create policy "Users read their own runs"
  on public.runs for select
  to authenticated
  using (created_by = (select auth.uid()));

create policy "Users queue their own runs"
  on public.runs for insert
  to authenticated
  with check (created_by = (select auth.uid()) and status = 'queued');

-- At most 3 runs waiting or running per user, so one account cannot fill the queue. (A trigger,
-- because a policy on runs that counts runs is refused as recursive.) The error code lets the
-- API answer 429.
create function public.limit_active_runs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Inserts for someone else fail the policy anyway; the service role is not limited.
  if new.created_by is distinct from auth.uid() then
    return new;
  end if;
  -- One insert at a time per user, so two at once cannot both pass the count.
  perform pg_advisory_xact_lock(hashtextextended('limit_active_runs:' || new.created_by::text, 0));
  if (select count(*) from public.runs where created_by = new.created_by and status in ('queued', 'running')) >= 3 then
    raise exception 'You already have 3 runs waiting or running. Try again when one finishes.'
      using errcode = '53400';
  end if;
  return new;
end;
$$;

revoke all on function public.limit_active_runs() from public, anon, authenticated;

create trigger runs_limit_active
  before insert on public.runs
  for each row execute function public.limit_active_runs();

create policy "Users read results of their own runs"
  on public.run_results for select
  to authenticated
  using (exists (select 1 from public.runs r where r.id = run_id and r.created_by = (select auth.uid())));

-- The queue --------------------------------------------------------------------------------

-- Claim the oldest queued run and mark it running. Concurrent callers each get a different run
-- (FOR UPDATE SKIP LOCKED), or none. Returns the claimed run, or no rows.
create function public.claim_next_run()
returns setof public.runs
language sql
volatile
security definer
set search_path = ''
as $$
  update public.runs
     set status = 'running', started_at = now(), finished_at = null, error = null
   where id = (
           select id
             from public.runs
            where status = 'queued'
            order by created_at, id
            limit 1
              for update skip locked
         )
     and status = 'queued'
  returning *;
$$;

comment on function public.claim_next_run() is 'Worker only: claim the oldest queued run (FOR UPDATE SKIP LOCKED) and mark it running.';

revoke all on function public.claim_next_run() from public, anon, authenticated;
grant execute on function public.claim_next_run() to service_role;

-- Report files -----------------------------------------------------------------------------
-- A private bucket; objects are '<run_id>/<file>'. Only the service role uploads. Users read
-- (and so can make signed URLs for) the files of their own runs.

insert into storage.buckets (id, name, public, file_size_limit)
values ('reports', 'reports', false, 10485760)
on conflict (id) do update set public = false;

create policy "Users read reports of their own runs"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'reports'
    and exists (
      select 1 from public.runs r
      where r.id::text = (storage.foldername(name))[1]
        and r.created_by = (select auth.uid())
    )
  );
