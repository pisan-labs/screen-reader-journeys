# Changes

Append-only journal, oldest first. Earlier history: `git log` and `docs/handoff.md`.

2026-11-23 [scope] Owner: make the hosted service a HintWise app (option B), on PManager's instructions; this session builds and opens PRs, PManager reviews and releases.

2026-11-23 [decision] Owner: no top-tier model in this project; times in Europe/Madrid until 6 Jan 2027; this session merges nothing, handoff PRs included.

2026-11-23 [note] Relay takeover: the previous session and its three scheduled tasks no longer exist, so there was nothing to move or archive.

2026-11-23 [doc] docs/hintwise-gap-report.md: three conflicts (own sign-in, tables in public, service-role key in the worker); the rest is additive.

2026-11-23 [decision] Owner: the worker gets its own Render service, free plan to start; TypeScript for the dashboard, tsc --checkJs for server and CLI; no relay scheduled tasks for this session.

2026-11-23 [code] Runs move to schema app_screen_reader_journeys (0001_runs.sql); the worker uses token-checked worker_* functions, no service-role key; reports move from Storage to run_reports.

2026-11-23 [code] Dashboard moves to Vite and TypeScript with the platform's sign-in (Google, emailed code), Delete my account, the HintWise footer, favicon, hw-events.js and a privacy note.

2026-11-23 [code] The tool now follows focus into open shadow roots; it reported the HintWise footer's host element instead of its links.

2026-11-23 [decision] Owner (via PManager): the worker's own Render service is on the free plan; PManager generates WORKER_TOKEN and pins its hash at release.

2026-11-23 [code] Review of #10, R1.1 to R1.7: safer report saving, downloads as octet-stream on click, per-run caps, retention (20 runs, 30 days, proposed), clock-free SQL test, ASCII token rule.

2026-11-23 [decision] PManager: retention and caps as proposed (20 runs per person, 30 days, 200 files, 20 MiB per run); the privacy note says so.

2026-11-23 [code] Review of #11, R2.1 (major): the worker stops RUN_AS_UID's processes, lists without following links and opens reports with O_NOFOLLOW; R2.2-R2.4, R2.6-R2.8 fixed; R2.5 to PR 3.

2026-11-23 [code] run_results: unique (run_id, journey, mode), and results must be for the run's own journeys and modes.

2026-11-23 [code] The server and the tool get ESLint, tsc --checkJs (JSDoc, non-strict) and a coverage gate on server/ at 85%; CI runs them.
