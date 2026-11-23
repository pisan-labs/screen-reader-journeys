# Changes

Append-only journal, oldest first. Earlier history: `git log` and `docs/handoff.md`.

2026-11-23 [scope] Owner: make the hosted service a HintWise app (option B), on PManager's instructions; this session builds and opens PRs, PManager reviews and releases.

2026-11-23 [decision] Owner: no top-tier model in this project; times in Europe/Madrid until 6 Jan 2027; this session merges nothing, handoff PRs included.

2026-11-23 [note] Relay takeover: the previous session and its three scheduled tasks no longer exist, so there was nothing to move or archive.

2026-11-23 [doc] docs/hintwise-gap-report.md: three conflicts (own sign-in, tables in public, service-role key in the worker); the rest is additive.

2026-11-23 [decision] Owner: the worker gets its own Render service, free plan to start; TypeScript for the dashboard, tsc --checkJs for server and CLI; no relay scheduled tasks for this session.

2026-11-23 [code] Runs move to schema app_screen_reader_journeys (0001_runs.sql); the worker uses token-checked worker_* functions, no service-role key; reports move from Storage to run_reports.
