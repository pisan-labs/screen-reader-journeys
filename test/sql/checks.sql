-- Checks for supabase/migrations, run by test/sql/run.sh after the stub and the migrations.
-- Each check raises an exception on failure, and psql stops at the first one.

create schema test;
grant usage on schema test to public;

-- Act as a role (and, for authenticated, a person) until the end of the transaction, as PostgREST does.
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

-- The worker's token in these tests, and the hash ops SQL would pin.
create function test.token() returns text language sql immutable as $$ select 'test-worker-token-0123456789abcdef0123456789' $$;

set search_path = app_screen_reader_journeys, public;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-00000000000a', 'a@example.org'),
  ('00000000-0000-4000-8000-00000000000b', 'b@example.org'),
  ('00000000-0000-4000-8000-00000000000c', 'c@example.org');

\echo 'the schema: row level security on every table, no table for anon, fixed search paths'
select test.check(
  (select bool_and(c.relrowsecurity) and not bool_or(c.relforcerowsecurity) from pg_class c
    where c.relnamespace = 'app_screen_reader_journeys'::regnamespace and c.relkind = 'r'),
  'every table has row level security, none forced');
select test.check(
  (select count(*) from pg_class c
    where c.relnamespace = 'app_screen_reader_journeys'::regnamespace and c.relkind = 'r') = 4,
  'four tables');
select test.check(
  not exists (select 1 from pg_class c
    where c.relnamespace = 'app_screen_reader_journeys'::regnamespace and c.relkind = 'r'
      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
        or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))),
  'anon has no table privilege');
select test.check(
  not has_table_privilege('authenticated', 'app_screen_reader_journeys.worker_config', 'select'),
  'nobody signed in reads worker_config');
select test.check(
  (select bool_and(p.proconfig @> array['search_path=""']) from pg_proc p
    where p.pronamespace = 'app_screen_reader_journeys'::regnamespace and p.prosecdef),
  'every security definer function has search_path ''''');
select test.check(
  (select count(*) from pg_proc p where p.pronamespace = 'app_screen_reader_journeys'::regnamespace and p.prosecdef) = 9,
  'nine security definer functions');
select test.check(
  (select bool_and(not has_function_privilege('authenticated', p.oid, 'execute')) from pg_proc p
    where p.pronamespace = 'app_screen_reader_journeys'::regnamespace),
  'no function is callable by signed-in people');
select test.check(
  (select array_agg(p.proname::text order by p.proname) from pg_proc p
    where p.pronamespace = 'app_screen_reader_journeys'::regnamespace and has_function_privilege('anon', p.oid, 'execute'))
  = array['worker_add_results', 'worker_claim_next_run', 'worker_fail_stale_runs', 'worker_finish_run', 'worker_prune_runs', 'worker_requeue_run', 'worker_save_report'],
  'anon may call exactly the seven worker functions');

\echo 'people queue runs with only the allowed columns, status queued, for themselves'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
insert into runs (base_url, journeys, modes)
  values ('https://a.vercel.app/', '{targets/generic/home-tab-order.journey.js}', '{walker}');
-- What the API sends.
insert into runs (user_id, status, base_url, journeys, modes)
  values ('00000000-0000-4000-8000-00000000000a', 'queued', 'https://b.vercel.app/', '{targets/generic/home-tab-order.journey.js}', '{walker,virtual}');
select test.check((select count(*) from runs) = 2, 'A sees both runs');
select test.check((select bool_and(user_id = '00000000-0000-4000-8000-00000000000a' and status = 'queued') from runs), 'user_id defaults to the person, status to queued');
commit;

\echo 'people cannot insert other statuses, for other people, or server-controlled columns'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.fails($$insert into app_screen_reader_journeys.runs (status, base_url, journeys, modes) values ('running', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'row-level security');
select test.fails($$insert into app_screen_reader_journeys.runs (status, base_url, journeys, modes) values ('done', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'row-level security');
select test.fails($$insert into app_screen_reader_journeys.runs (user_id, base_url, journeys, modes) values ('00000000-0000-4000-8000-00000000000b', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'row-level security');
select test.fails($$insert into app_screen_reader_journeys.runs (created_at, base_url, journeys, modes) values (now() - interval '1 year', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
select test.fails($$insert into app_screen_reader_journeys.runs (id, base_url, journeys, modes) values (gen_random_uuid(), 'https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
select test.fails($$insert into app_screen_reader_journeys.runs (summary, base_url, journeys, modes) values ('{}', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
select test.fails($$insert into app_screen_reader_journeys.runs (started_at, base_url, journeys, modes) values (now(), 'https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
commit;

\echo 'the table refuses malformed runs'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.fails($$insert into app_screen_reader_journeys.runs (base_url, journeys, modes) values ('https://a.vercel.app/', '{x}', '{voiceover}')$$, 'check constraint');
select test.fails($$insert into app_screen_reader_journeys.runs (base_url, journeys, modes) values ('https://a.vercel.app/', '{x}', '{}')$$, 'check constraint');
select test.fails($$insert into app_screen_reader_journeys.runs (base_url, journeys, modes) values ('https://a.vercel.app/', '{}', '{walker}')$$, 'check constraint');
select test.fails($$insert into app_screen_reader_journeys.runs (base_url, journeys, modes) values ('file:///etc/passwd', '{x}', '{walker}')$$, 'check constraint');
commit;

\echo 'at most 3 runs waiting or running per person'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
insert into runs (base_url, journeys, modes) values ('https://c.vercel.app/', '{x}', '{walker}');
select test.fails($$insert into app_screen_reader_journeys.runs (base_url, journeys, modes) values ('https://d.vercel.app/', '{x}', '{walker}')$$, 'already have 3 runs');
commit;
\echo 'the limit is error code 53400, which the API answers with 429'
do $$
begin
  perform test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
  insert into app_screen_reader_journeys.runs (base_url, journeys, modes) values ('https://d.vercel.app/', '{x}', '{walker}');
  raise exception 'the fourth run was accepted';
exception when sqlstate '53400' then
  null;
end
$$;
\echo 'the limit does not reveal another person''s runs: an insert for someone else fails on the policy'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000b');
select test.fails($$insert into app_screen_reader_journeys.runs (user_id, base_url, journeys, modes) values ('00000000-0000-4000-8000-00000000000a', 'https://a.vercel.app/', '{x}', '{walker}')$$, 'row-level security');
select test.fails($$select app_screen_reader_journeys.limit_active_runs()$$, 'permission denied|trigger functions can only be called as triggers');
commit;

\echo 'people see only their own runs, and cannot change them'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000b');
select test.check((select count(*) from runs) = 0, 'B sees none of A''s runs');
insert into runs (base_url, journeys, modes) values ('https://b.vercel.app/', '{x}', '{walker}');
select test.check((select count(*) from runs) = 1, 'B sees their own run');
commit;
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.check((select count(*) from runs) = 3, 'A sees their 3 runs');
select test.fails($$update app_screen_reader_journeys.runs set status = 'done'$$, 'permission denied');
commit;
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000b');
delete from runs where user_id = '00000000-0000-4000-8000-00000000000a';
commit;
select test.check((select count(*) from runs where user_id = '00000000-0000-4000-8000-00000000000a') = 3, 'B cannot delete A''s runs');

\echo 'anonymous callers get nothing, and the worker functions refuse every token until one is pinned'
begin;
select test.act_as('anon');
select test.fails($$select * from app_screen_reader_journeys.runs$$, 'permission denied');
select test.fails($$select * from app_screen_reader_journeys.run_results$$, 'permission denied');
select test.fails($$select * from app_screen_reader_journeys.run_reports$$, 'permission denied');
select test.fails($$select * from app_screen_reader_journeys.worker_config$$, 'permission denied');
select test.fails($$insert into app_screen_reader_journeys.runs (base_url, journeys, modes) values ('https://a.vercel.app/', '{x}', '{walker}')$$, 'permission denied');
select test.fails($$select app_screen_reader_journeys.worker_token_ok(test.token())$$, 'permission denied');
select test.fails($$select * from app_screen_reader_journeys.worker_claim_next_run(test.token())$$, 'bad worker token');
select test.fails($$select * from app_screen_reader_journeys.worker_claim_next_run(null)$$, 'bad worker token');
commit;

\echo 'signed-in people may not call the worker functions'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.fails($$select * from app_screen_reader_journeys.worker_claim_next_run(test.token())$$, 'permission denied');
select test.fails($$select app_screen_reader_journeys.worker_finish_run(test.token(), gen_random_uuid(), 'done', null, null)$$, 'permission denied');
commit;

-- What the gated ops SQL does once the owner says yes (as the migration role).
insert into worker_config (id, token_sha256)
values (true, encode(sha256(convert_to(test.token(), 'UTF8')), 'hex'))
on conflict (id) do update set token_sha256 = excluded.token_sha256, updated_at = now();

\echo 'with the hash pinned, a wrong or short token is still refused'
begin;
select test.act_as('anon');
select test.fails($$select * from app_screen_reader_journeys.worker_claim_next_run('test-worker-token-0123456789abcdef0123456780')$$, 'bad worker token');
select test.fails($$select * from app_screen_reader_journeys.worker_claim_next_run('short')$$, 'bad worker token');
select test.fails($$select app_screen_reader_journeys.worker_fail_stale_runs('nope-nope-nope-nope-nope-nope-nope-nope', 3600)$$, 'bad worker token');
select test.fails($$select app_screen_reader_journeys.worker_requeue_run('nope-nope-nope-nope-nope-nope-nope-nope', gen_random_uuid())$$, 'bad worker token');
select test.fails($$select app_screen_reader_journeys.worker_save_report('nope-nope-nope-nope-nope-nope-nope-nope', gen_random_uuid(), 'a.md', 'text/markdown', 'x')$$, 'bad worker token');
select test.fails($$select app_screen_reader_journeys.worker_add_results('nope-nope-nope-nope-nope-nope-nope-nope', gen_random_uuid(), '[]')$$, 'bad worker token');
select test.fails($$select app_screen_reader_journeys.worker_finish_run('nope-nope-nope-nope-nope-nope-nope-nope', gen_random_uuid(), 'done', null, null)$$, 'bad worker token');
select test.fails($$select app_screen_reader_journeys.worker_prune_runs('nope-nope-nope-nope-nope-nope-nope-nope')$$, 'bad worker token');
-- The right token with a space in it, or past 200 characters: refused like the server refuses it.
select test.fails($$select app_screen_reader_journeys.worker_prune_runs(test.token() || ' ')$$, 'bad worker token');
select test.fails($$select app_screen_reader_journeys.worker_prune_runs(repeat('x', 201))$$, 'bad worker token');
commit;

\echo 'worker_claim_next_run takes the oldest queued run and marks it running'
-- Make one run clearly the oldest (as the table owner).
update runs set created_at = now() - interval '1 hour' where base_url = 'https://a.vercel.app/';
begin;
select test.act_as('anon');
create temporary table claimed on commit drop as select * from app_screen_reader_journeys.worker_claim_next_run(test.token());
select test.check((select count(*) from claimed) = 1, 'one run claimed');
commit;
select test.check((select status = 'running' and started_at is not null from runs where base_url = 'https://a.vercel.app/'), 'the oldest run, marked running');

\echo 'the worker saves reports and results only for a running run, copying its owner'
select id as run_a from runs where base_url = 'https://a.vercel.app/' \gset
select id as run_queued from runs where base_url = 'https://b.vercel.app/' and user_id = '00000000-0000-4000-8000-00000000000a' \gset
begin;
select test.act_as('anon');
select test.check(app_screen_reader_journeys.worker_save_report(test.token(), :'run_a', 'summary.md', 'text/markdown; charset=utf-8', '# Summary'), 'report saved');
select test.check(app_screen_reader_journeys.worker_save_report(test.token(), :'run_a', 'summary.md', 'text/markdown; charset=utf-8', '# Summary, again'), 'the same path is replaced');
select test.check(app_screen_reader_journeys.worker_save_report(test.token(), :'run_a', 'home-page-tab-order.walker.md', 'text/markdown; charset=utf-8', '# Home'), 'second report saved');
select test.fails(format($$select app_screen_reader_journeys.worker_save_report(test.token(), %L, '../etc/passwd', 'text/plain', 'x')$$, :'run_a'), 'check constraint');
select test.fails(format($$select app_screen_reader_journeys.worker_save_report(test.token(), %L, '/abs.md', 'text/plain', 'x')$$, :'run_a'), 'check constraint');
select test.check(not app_screen_reader_journeys.worker_save_report(test.token(), :'run_queued', 'summary.md', 'text/markdown', 'x'), 'a queued run takes no reports');
-- A mode the run does not have (and the table would refuse anyway).
select test.fails(format($$select app_screen_reader_journeys.worker_add_results(test.token(), %L, '[{"journey": "targets/generic/home-tab-order.journey.js", "mode": "voiceover", "status": "pass"}]')$$, :'run_a'), 'one of the run''s journeys and modes');
select test.fails(format($$select app_screen_reader_journeys.worker_add_results(test.token(), %L, '[{"journey": "targets/generic/home-tab-order.journey.js", "mode": "walker", "status": "maybe"}]')$$, :'run_a'), 'check constraint');
select test.check(app_screen_reader_journeys.worker_add_results(test.token(), :'run_a',
  '[{"journey": "targets/generic/home-tab-order.journey.js", "mode": "walker", "status": "pass", "checks_passed": 1, "checks_total": 1, "errors": 0, "warnings": 2, "report_path": "home-page-tab-order.walker.md"}]') = 1, 'one result added');
select test.check(app_screen_reader_journeys.worker_add_results(test.token(), :'run_queued', '[{"journey": "x", "mode": "walker", "status": "pass"}]') = 0, 'a queued run takes no results');
select test.fails($$select app_screen_reader_journeys.worker_add_results(test.token(), gen_random_uuid(), '{}')$$, 'json array');
commit;
\echo 'per run: one result per journey and mode of the run, 200 files and 20 MiB of reports'
begin;
select test.act_as('anon');
-- run_a has 1 journey and 1 mode, and already has its one result.
select test.fails(format($$select app_screen_reader_journeys.worker_add_results(test.token(), %L, '[{"journey": "targets/generic/home-tab-order.journey.js", "mode": "walker", "status": "fail"}]')$$, :'run_a'), 'run_results_one_per_journey_mode');
select test.fails(format($$select app_screen_reader_journeys.worker_add_results(test.token(), %L, '[{"journey": "x", "mode": "walker", "status": "pass"}]')$$, :'run_a'), 'one of the run''s journeys and modes');
select test.fails(format($$select app_screen_reader_journeys.worker_add_results(test.token(), %L, '[{"journey": "targets/generic/home-tab-order.journey.js", "mode": "virtual", "status": "pass"}]')$$, :'run_a'), 'one of the run''s journeys and modes');
select test.fails(format($$select app_screen_reader_journeys.worker_add_results(test.token(), %L, '[{"mode": "walker", "status": "pass"}]')$$, :'run_a'), 'one of the run''s journeys and modes');
select test.fails(format($$select app_screen_reader_journeys.worker_save_report(test.token(), %L, 'big.md', 'text/markdown', repeat('x', 2097153))$$, :'run_a'), 'check constraint');
select app_screen_reader_journeys.worker_save_report(test.token(), :'run_a', 'f' || n || '.md', 'text/plain', repeat('x', 2097152)) from generate_series(1, 9) n;
select test.fails(format($$select app_screen_reader_journeys.worker_save_report(test.token(), %L, 'f10.md', 'text/plain', repeat('x', 2097152))$$, :'run_a'), 'at most 20 MiB');
select test.check(app_screen_reader_journeys.worker_save_report(test.token(), :'run_a', 'f9.md', 'text/plain', 'smaller now'), 'replacing a file counts its new size, not the old');
rollback;
begin;
select test.act_as('anon');
select app_screen_reader_journeys.worker_save_report(test.token(), :'run_a', 'n' || n || '.md', 'text/plain', 'x') from generate_series(1, 198) n;
select test.fails(format($$select app_screen_reader_journeys.worker_save_report(test.token(), %L, 'one-too-many.md', 'text/plain', 'x')$$, :'run_a'), 'at most 200 report files');
rollback;
select test.check((select count(*) from run_reports) = 2, 'two report files');
select test.check((select body from run_reports where path = 'summary.md') = '# Summary, again', 'the replaced report');
select test.check((select bool_and(user_id = '00000000-0000-4000-8000-00000000000a') from run_reports), 'reports belong to the run''s owner');
select test.check((select bool_and(user_id = '00000000-0000-4000-8000-00000000000a') from run_results), 'results belong to the run''s owner');

\echo 'people read only their own results and reports, and cannot write them'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
select test.check((select count(*) from run_results) = 1, 'A reads their result');
select test.check((select count(*) from run_reports) = 2, 'A reads their reports');
select test.fails($$insert into app_screen_reader_journeys.run_results (run_id, journey, mode, status) select id, 'x', 'walker', 'pass' from app_screen_reader_journeys.runs limit 1$$, 'permission denied');
select test.fails($$update app_screen_reader_journeys.run_results set status = 'fail'$$, 'permission denied');
select test.fails($$insert into app_screen_reader_journeys.run_reports (run_id, path, content_type, body) select id, 'x.md', 'text/plain', 'x' from app_screen_reader_journeys.runs limit 1$$, 'permission denied');
select test.fails($$update app_screen_reader_journeys.run_reports set body = 'x'$$, 'permission denied');
commit;
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000b');
select test.check((select count(*) from run_results) = 0, 'B reads none of A''s results');
select test.check((select count(*) from run_reports) = 0, 'B reads none of A''s reports');
commit;

\echo 'the worker finishes only a running run, with done or failed'
begin;
select test.act_as('anon');
select test.fails($$select app_screen_reader_journeys.worker_finish_run(test.token(), gen_random_uuid(), 'queued', null, null)$$, 'done or failed');
select test.check(app_screen_reader_journeys.worker_finish_run(test.token(), :'run_a', 'done', null, '{"results": 1}'), 'finished');
select test.check(not app_screen_reader_journeys.worker_finish_run(test.token(), :'run_a', 'failed', 'again', null), 'a finished run stays finished');
commit;
select test.check((select status = 'done' and finished_at is not null and summary = '{"results": 1}' from runs where base_url = 'https://a.vercel.app/'), 'done, with its summary');

\echo 'the worker requeues a running run, and fails stale ones'
begin;
select test.act_as('anon');
create temporary table claimed on commit drop as select * from app_screen_reader_journeys.worker_claim_next_run(test.token());
select test.check(app_screen_reader_journeys.worker_requeue_run(test.token(), (select id from claimed)), 'requeued');
select test.check(not app_screen_reader_journeys.worker_requeue_run(test.token(), (select id from claimed)), 'a queued run is not requeued again');
select test.fails($$select app_screen_reader_journeys.worker_fail_stale_runs(test.token(), 1)$$, 'at least 60');
commit;
update runs set status = 'running', started_at = now() - interval '2 hours' where base_url = 'https://c.vercel.app/';
begin;
select test.act_as('anon');
select test.check(app_screen_reader_journeys.worker_fail_stale_runs(test.token(), 3600) = 1, 'one stale run failed');
commit;
select test.check((select status = 'failed' and error like 'The server stopped%' from runs where base_url = 'https://c.vercel.app/'), 'the stale run failed');

\echo 'deleting a run deletes its results and reports'
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000a');
delete from runs where base_url = 'https://a.vercel.app/';
select test.check((select count(*) from runs) = 2, 'A has 2 runs left');
commit;
select test.check((select count(*) from run_results) = 0 and (select count(*) from run_reports) = 0, 'results and reports went with the run');

\echo 'retention: finished runs over 30 days old are pruned, and each person keeps their 20 latest runs'
insert into auth.users (id, email) values ('00000000-0000-4000-8000-00000000000e', 'e@example.org');
insert into runs (user_id, base_url, journeys, modes, status, created_at, finished_at)
  select '00000000-0000-4000-8000-00000000000e', 'https://old-' || n || '.vercel.app/', '{x}', '{walker}', 'done',
         now() - make_interval(days => 40 - n) + interval '12 hours', now() - make_interval(days => 40 - n) + interval '12 hours'
    from generate_series(1, 22) n;
begin;
select test.act_as('anon');
-- Finished 39.5 to 30.5 days ago: 9 runs (the next is 29.5 days old).
select test.check(x.pruned = 9, 'nine runs finished over 30 days ago, pruned ' || x.pruned) from (select app_screen_reader_journeys.worker_prune_runs(test.token()) as pruned) x;
commit;
select test.check((select count(*) from runs where user_id = '00000000-0000-4000-8000-00000000000e') = 13, '13 left');
insert into runs (user_id, base_url, journeys, modes, status, created_at, finished_at)
  select '00000000-0000-4000-8000-00000000000e', 'https://new-' || n || '.vercel.app/', '{x}', '{walker}', 'done', now() - make_interval(mins => 30 - n), now()
    from generate_series(1, 7) n;
begin;
select test.act_as('authenticated', '00000000-0000-4000-8000-00000000000e');
insert into runs (base_url, journeys, modes) values ('https://latest.vercel.app/', '{x}', '{walker}');
commit;
select test.check((select count(*) from runs where user_id = '00000000-0000-4000-8000-00000000000e') = 20, 'the person keeps 20 runs');
select test.check(exists (select 1 from runs where base_url = 'https://latest.vercel.app/'), 'the new run is kept');
select test.check(not exists (select 1 from runs where base_url = 'https://old-10.vercel.app/'), 'the oldest run went');
select test.check((select count(*) from runs where user_id = '00000000-0000-4000-8000-00000000000b') = 1, 'nobody else''s runs went');

\echo 'deleting an account deletes everything it owns'
begin;
select test.act_as('anon');
create temporary table claimed on commit drop as select * from app_screen_reader_journeys.worker_claim_next_run(test.token());
select app_screen_reader_journeys.worker_save_report(test.token(), (select id from claimed), 'summary.md', 'text/markdown', 'x');
select app_screen_reader_journeys.worker_add_results(test.token(), (select id from claimed), '[{"journey": "targets/generic/home-tab-order.journey.js", "mode": "walker", "status": "pass"}]');
commit;
delete from auth.users where id = '00000000-0000-4000-8000-00000000000a';
select test.check((select count(*) from runs where user_id = '00000000-0000-4000-8000-00000000000a') = 0, 'A''s runs are gone');
select test.check((select count(*) from run_results) + (select count(*) from run_reports) = 0, 'A''s results and reports are gone');

\echo 'worker_claim_next_run returns nothing when the queue is empty'
update runs set status = 'done';
begin;
select test.act_as('anon');
select test.check((select count(*) from app_screen_reader_journeys.worker_claim_next_run(test.token())) = 0, 'nothing to claim');
commit;
