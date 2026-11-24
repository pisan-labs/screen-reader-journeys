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

2026-11-23 [code] R2.5 (review of #11): the portable focus reader and selectOption take the last :focus match, so focus inside a shadow root is the focused element; live regions in shadow roots are still not heard.

2026-11-23 [code] Review of #11 round 2: the run's work folder stays root-owned, the reports folder is checked before reading, processes are killed by user (kill -1 as that user) and counted by thread, hard links are refused.

2026-11-23 [decision] PManager: tini as PID 1 in the image (ENTRYPOINT ["/usr/bin/tini", "--"]), so orphaned zombies are reaped.

2026-11-23 [code] Review of #11 round 3: the stop also kills each pid from root and limits the helper; a failed stop reads and deletes nothing and ends the server; tini -s.

2026-11-24 [decision] Owner ("SR fix 1", via PManager): fix R2.F-1 by reading and deleting the run's files as the run's user, and a stop that is proven by a completed kill(-1) as that user.

2026-11-24 [code] R2.F-1 to R2.F-3: report-child.js reads and clears as RUN_AS_UID over IPC, root only rmdirs; the stop returns only after a completed kill(-1) helper and an empty scan; pause timers cleared.

2026-11-24 [code] R2.G-1, R2.G-3: the kill helper starts as root and drops to the user with no exec, so the user cannot trace it; the helper-limit test is deterministic.

2026-11-24 [code] R2.G-2, R2.G-4, R2.G-5: a partial clear ends the server; the child's answers are checked, the whole read is bounded; tests fail if root reads or deletes.

2026-11-24 [code] R2.H-1 to R2.H-3 in PR 4: the child empties reports/ made read-only; no worker start unless fs.suid_dumpable is 0 or 2; the read limit counts only the child's answers.

2026-11-24 [decision] Owner: yes to fixing frontend#10's stuck player and unlinked stop hint on the owner's fork branch (a375bde, pushed); no further reply on that PR.

2026-11-24 [decision] PManager: #12 merged at a12086b; R2.H-1 to R2.H-3 and #12's minors R3.1 to R3.5 go in PR 4, from main; one release after PR 4 merges.

2026-11-24 [code] PR 4: CI runs the root-only tests as root; index.js is measured; Node-only lint globals for server/; engines Node >=22.8; the run child forks with no execArgv.

2026-11-24 [decision] PManager: #13 merged as b8e95fe; R4.1 to R4.3 go in a small follow-up PR that does not block the release.

2026-11-24 [code] R4.1 to R4.3: saving reports is bounded in time and stops at the 200-file cap; tests use an injected clock; no persisted CI token.

2026-11-24 [decision] PManager: #14 merged as c2dc383; R5.1 to R5.3 listed in issue #15; a small PR for R5.1 before the service takes others' runs.

2026-11-24 [code] R5.1: the run summary is kept under 48 KiB of JSON (names and blocked entries cut by code point, then trimmed); per-file log lines capped at 30.

2026-11-24 [scope] Owner (via PManager): any signed-in person may test any public address; built as ALLOWED_TARGET_HOSTS="*", the allow-list stays the default.

2026-11-24 [code] "*" rule: public hosts only, ports 80 and 443, checked at queue, run start and every connection; migration 0002 adds 10 runs per person per UTC day.

2026-11-24 [decision] PManager: daily cap 10 per UTC day, one constant (daily_run_limit()); 80/443 for hosts not listed exactly in every mode; R6.2 folded into this PR.

2026-11-24 [code] R6.2: the run process's messages are checked (shape, counts, strings), text made well formed and cut from bounded slices, names quoted in the log.

2026-11-24 [code] #17 round 1: total of 40 runs a day (0002), 100 MB per run through the proxy, results bound to the job, quoted output, no ports on wildcard rules (R7.2 to R7.6).

2026-11-24 [code] R7.1 (proposed option A): with "*", the worker starts only if CHROMIUM_SANDBOX=true and a sandboxed Chromium starts as the run user (sandbox-probe.js).

2026-11-24 [decision] PManager (T1) on #17 round 1: R7.1 option A; total 40 a day; 100 MB per run; the dashboard says the page is opened by a browser on our server.

2026-11-24 [code] #17 round 2: the run process has no IPC; job on stdin, messages as JSON lines on fd 3, at most 1 MB each; the dashboard sentence; "byte limit" in blocked.

2026-11-24 [decision] PManager (T1): every wildcard rule needs the sandbox gate too (R8.3); round 3 is #17's last round.

2026-11-24 [code] #17 round 3: the byte limit counts the browser's sockets (headers, uploads, tunnels), 500 host names a run, 256 KB messages, wildcards gated.
