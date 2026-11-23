-- The parts of a Supabase database that the migrations rely on, for test/sql/run.sh: the API
-- roles, auth.users and auth.uid(), and generous default grants. Real Supabase has much more;
-- this is only enough to apply the migrations and check their privileges, policies and
-- functions.

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

-- The worst case: the API roles get everything on every new table, function and sequence, in
-- any schema. The migrations must revoke what they do not want.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges grant all on tables to anon, authenticated, service_role;
alter default privileges grant all on functions to anon, authenticated, service_role;
alter default privileges grant all on sequences to anon, authenticated, service_role;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text);

-- As in Supabase: the user id from the JWT claims PostgREST puts in request.jwt.claims.
-- An empty setting (left by an earlier transaction's set_config(..., true)) means nobody.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
