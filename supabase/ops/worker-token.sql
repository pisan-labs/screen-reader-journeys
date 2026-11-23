-- Pin the SHA-256 of the worker's WORKER_TOKEN (docs/deploy.md, "The worker token").
--
-- Run with the Supabase admin workflow's `sql` command, after the owner's yes, once the token is
-- set on the Render service. The hash is not secret; the token is, and never appears here.
--
-- Replace the 64 zeros below with the output of:
--   printf %s "$WORKER_TOKEN" | shasum -a 256
-- The check refuses the placeholder, so running this file unchanged does nothing.

do $$
declare
  v_sha256 text := '0000000000000000000000000000000000000000000000000000000000000000';
begin
  if v_sha256 !~ '^[0-9a-f]{64}$' or v_sha256 = repeat('0', 64) then
    raise exception 'Put the token''s SHA-256 (64 lowercase hex characters) in v_sha256 first.';
  end if;
  insert into app_screen_reader_journeys.worker_config (id, token_sha256)
  values (true, v_sha256)
  on conflict (id) do update set token_sha256 = excluded.token_sha256, updated_at = now();
end
$$;

-- Prints the pinned hash and when it was set.
select token_sha256, updated_at from app_screen_reader_journeys.worker_config;
