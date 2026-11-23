-- Checks for supabase/migrations, run by test/sql/run.sh after the stub and the migrations.
-- Each check raises an exception on failure, and psql stops at the first one.

create schema test;
grant usage on schema test to public;

-- Act as a role (and, for authenticated, a user) until the end of the transaction, as PostgREST does.
create function test.act_as(role_name text, uid uuid default null) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', role_name)::text, true);
  execute format('set local role %I', role_name);
end
$$;

-- Run a statement and require it to fail with a message matching a pattern.
create function test.fails(stmt text, pattern text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlerrm !~* pattern then
      raise exception 'expected an error matching "%" from [%], got: %', pattern, stmt, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected [%] to fail with an error matching "%"', stmt, pattern;
end
$$;

create function test.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'check failed: %', what; end if;
end
$$;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'a@example.org'),
  ('00000000-0000-4000-8000-00000000000b', 'b@example.org');

\echo 'users queue runs with only the allowed columns, status queued, for themselves'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
insert into public.runs (base_url, journeys, modes)
  values ('https://a.vercel.app/', '{targets/generic/home-tab-order.journey.js}', '{walker}');
-- What the API sends.
insert into public.runs (created_by, status, base_url, journeys, modes)
  values ('00000000-0000-4000-8000-00000000000a', 'queued', 'https://b.vercel.app/', '{targets/generic/home-tab-order.journey.js}', '{walker,virtual}');
select test.check((select count(*) from public.runs) = 2, 'A sees both runs');
select test.check((select bool_and(created_by = '00000000-0000-4000-8000-00000000000a' and status = 'queued') from public.runs), 'created_by defaults to the user, status to queued');
commit;

\echo 'users cannot insert other statuses, for other users, or server-controlled columns'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.fails($$insert into public.runs (status, base_url, journeys, modes) values ('running', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'row-level security');
select test.fails($$insert into public.runs (status, base_url, journeys, modes) values ('done', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'row-level security');
select test.fails($$insert into public.runs (created_by, base_url, journeys, modes) values ('00000000-0000-4000-8000-00000000000b', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'row-level security');
select test.fails($$insert into public.runs (created_at, base_url, journeys, modes) values (now() - interval '1 year', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
select test.fails($$insert into public.runs (id, base_url, journeys, modes) values (gen_random_uuid(), 'https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
select test.fails($$insert into public.runs (summary, base_url, journeys, modes) values ('{}', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
select test.fails($$insert into public.runs (started_at, base_url, journeys, modes) values (now(), 'https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
commit;

\echo 'the table refuses malformed runs'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.fails($$insert into public.runs (base_url, journeys, modes) values ('https://a.vercel.app/', '{x}', '{voiceover}')$$, 'check constraint');
select test.fails($$insert into public.runs (base_url, journeys, modes) values ('https://a.vercel.app/', '{x}', '{}')$$, 'check constraint');
select test.fails($$insert into public.runs (base_url, journeys, modes) values ('https://a.vercel.app/', '{}', '{walker}')$$, 'check constraint');
select test.fails($$insert into public.runs (base_url, journeys, modes) values ('file:///etc/passwd', '{x}', '{walker}')$$, 'check constraint');
commit;

\echo 'at most 3 runs waiting or running per user'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
insert into public.runs (base_url, journeys, modes) values ('https://c.vercel.app/', '{x}', '{walker}');
select test.fails($$insert into public.runs (base_url, journeys, modes) values ('https://d.vercel.app/', '{x}', '{walker}')$$, 'already have 3 runs');
commit;
\echo 'the limit is error code 53400, which the API answers with 429'
do $$
begin
  perform test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
  insert into public.runs (base_url, journeys, modes) values ('https://d.vercel.app/', '{x}', '{walker}');
  raise exception 'the fourth run was accepted';
exception when sqlstate '53400' then
  null;
end
$$;
\echo 'the limit does not reveal another user''s runs: an insert for someone else fails on the policy'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000b');
select test.fails($$insert into public.runs (created_by, base_url, journeys, modes) values ('00000000-0000-4000-8000-00000000000a', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'row-level security');
select test.fails($$select public.limit_active_runs()$$, 'permission denied|trigger functions can only be called as triggers');
commit;

\echo 'users see only their own runs, and cannot change or delete them'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000b');
select test.check((select count(*) from public.runs) = 0, 'B sees none of A''s runs');
insert into public.runs (base_url, journeys, modes) values ('https://b.vercel.app/', '{x}', '{walker}');
select test.check((select count(*) from public.runs) = 1, 'B sees their own run');
commit;
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.check((select count(*) from public.runs) = 3, 'A sees their 3 runs');
select test.fails($$update public.runs set status = 'done'$$, 'permission denied');
select test.fails($$delete from public.runs$$, 'permission denied');
commit;

\echo 'anonymous callers get nothing'
begin;
select test.act_as('anon');
select test.fails($$select * from public.runs$$, 'permission denied');
select test.fails($$select * from public.run_results$$, 'permission denied');
select test.fails($$insert into public.runs (base_url, journeys, modes) values ('https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
select test.fails($$select * from public.claim_next_run()$$, 'permission denied');
commit;

\echo 'only the service role may claim runs'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.fails($$select * from public.claim_next_run()$$, 'permission denied');
commit;

\echo 'claim_next_run takes the oldest queued run and marks it running'
-- Make one run clearly the oldest (as the table owner).
update public.runs set created_at = now() - interval '1 hour' where base_url = 'https://a.vercel.app/';
begin;
select test.act_as('service_role');
create temporary table claimed on commit drop as select * from public.claim_next_run();
select test.check((select count(*) from claimed) = 1, 'one run claimed');
select test.check((select id from claimed) = (select id from public.runs where base_url = 'https://a.vercel.app/'), 'the oldest run');
select test.check((select status = 'running' and started_at is not null from public.runs where id = (select id from claimed)), 'marked running');
commit;

\echo 'results and reports: users read only their own'
insert into public.run_results (run_id, journey, mode, status, checks_passed, checks_total, errors, warnings, report_path)
  select id, 'targets/generic/home-tab-order.journey.js', 'walker', 'pass', 1, 1, 0, 2, id || '/home-page-tab-order.walker.md' from public.runs;
insert into storage.objects (bucket_id, name)
  select 'reports', id || '/summary.md' from public.runs
  union all select 'reports', 'not-a-run/summary.md'
  union all select 'reports', 'loose-file.md';
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.check((select count(*) from public.run_results) = 3, 'A reads the results of their 3 runs');
select test.check((select count(*) from storage.objects) = 3, 'A reads the report files of their 3 runs only');
select test.fails($$insert into public.run_results (run_id, journey, mode, status) select id, 'x', 'walker', 'pass' from public.runs limit 1$$, 'permission denied');
select test.fails($$update public.run_results set status = 'fail'$$, 'permission denied');
commit;
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000b');
select test.check((select count(*) from public.run_results) = 1, 'B reads only their result');
select test.check((select count(*) from storage.objects) = 1, 'B reads only their report file');
commit;
select test.check((select public = false from storage.buckets where id = 'reports'), 'the reports bucket is private');

\echo 'claim_next_run returns nothing when the queue is empty'
update public.runs set status = 'done';
begin;
select test.act_as('service_role');
select test.check((select count(*) from public.claim_next_run()) = 0, 'nothing to claim');
commit;
