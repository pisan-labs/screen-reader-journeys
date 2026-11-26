# Deploying the hosted service

The tool also runs as a small hosted service, a HintWise app at
`https://screen-reader-journeys.hintwise.org`. People sign in to a dashboard, pick a site and
some journeys, and read the transcripts when the run finishes. It follows claude-built-apps
`docs/new-app-guide.md`, option B (an app in its own repository).

```
  Browser ──────────────► Netlify: web/ (static dashboard)
     │                        │
     │ sign in, list runs,    │ GET /journeys, POST /runs, GET /runs/:id(/progress)
     │ read reports           ▼
     │                    Render: server/ (Docker: HTTP API + worker + Chromium)
     ▼                        │  the API acts as the signed-in person (row level security);
  Supabase (shared HintWise ◄─┘  the worker calls only the worker_* functions, with
  project): Auth, schema         WORKER_TOKEN
  app_screen_reader_journeys
```

| Where | What runs | Which credentials |
|---|---|---|
| Supabase, the shared HintWise project (`https://auth.hintwise.org`) | Sign-in, and the schema `app_screen_reader_journeys`: `runs`, `run_results`, `run_reports` and `worker_config` | — |
| Render, a service of its own | `server/index.js`: the API and, in the same process, the worker that runs journeys in walker and virtual modes | the public anon key, and `WORKER_TOKEN` |
| Netlify | `web/`: the dashboard (Vite and TypeScript), with the platform's sign-in (Google or an emailed 6-digit code) and "Delete my account" | the public anon key only |

**No service-role key anywhere.** The server refuses to start if `SUPABASE_SERVICE_ROLE_KEY` is
set.

The real screen readers need their own operating systems, so the service runs only `walker` and
`virtual`. Use the CLI or the GitHub workflows for `voiceover`, `orca` and `nvda`.

## Who does what

In the HintWise workflow, this repository's session builds and opens pull requests. PManager
releases, and each production step waits for the owner's yes.

| Step | Who |
|---|---|
| Copy each migration byte for byte into claude-built-apps `screen-reader-journeys/supabase/migrations/`, apply it, expose the schema, run `check-schema` | PManager (Supabase admin workflow), after the owner's yes |
| Make `WORKER_TOKEN` | the owner |
| Pin the token's SHA-256 (`supabase/ops/worker-token.sql`) | PManager (Supabase admin `sql`), after the owner's yes |
| Create the Render service and set its environment | PManager (Deploy workflow, from a `deploy/target.yml` in claude-built-apps), after the owner's yes; a paid plan is the owner's decision |
| Import the repository in Netlify, with Deploy Previews and branch deploys off | the owner |
| Attach `screen-reader-journeys.hintwise.org` | PManager ("Attach custom domain") |
| Add the sign-in label `screen-reader-journeys` to `EXTERNAL_APP_LABELS` and redeploy sign-in-link and delete-account | PManager, after the owner's yes |

## 1. The database

1. **Migrations,** applied in order, each idempotently. `0001_runs.sql` creates everything in
   the schema `app_screen_reader_journeys`; `0002_daily_cap.sql` adds the daily limit:
   - **`runs`.** Signed-in people read their own, queue new ones (status `queued` only, at most
     three waiting or running) and delete their own.
   - **`run_results` and `run_reports`.** People read their own.
   - **`worker_config`.** The SHA-256 of `WORKER_TOKEN`. Nobody reads it through the API.
   - **The worker functions**, each `security definer` with `search_path = ''`, which only `anon`
     may call: `worker_claim_next_run`, `worker_fail_stale_runs`, `worker_prune_runs`,
     `worker_requeue_run`, `worker_save_report`, `worker_add_results` and `worker_finish_run`.
     Each checks the token's SHA-256 against `worker_config` and refuses every token until that
     row exists.
   - **`run_counts` and `run_totals`** (0002). How many runs each person, and everyone together,
     started per UTC day, for the limits of 10 and 40 a day (`daily_run_limit()` and
     `daily_total_limit()`, one line each to change). Only a trigger writes them; nobody reads or
     changes them through the API, so deleting one's runs does not reset them, and deleting an
     account does not lower the total. They keep today and yesterday, for everyone.
2. **Expose the schema** to the Data API (`expose-schema app_screen_reader_journeys`). Until then,
   PostgREST answers 406 for every request.
3. **`check-schema app_screen_reader_journeys`** must pass before the first deploy.

Every table has `user_id ... references auth.users (id) on delete cascade`, so the platform's
"Delete my account" removes a person's runs, results and reports.

## 2. The worker token

The worker proves itself to the `worker_*` functions with a random token. The database keeps only
the token's SHA-256, which is not secret.

1. The owner makes the token (32 to 200 printable ASCII characters, without spaces), and keeps it
   out of chat, files and workflow inputs:

   ```bash
   openssl rand -base64 32
   ```

2. The owner (or PManager, with the owner's yes) sets it on the Render service as the secret
   `WORKER_TOKEN`.
3. The owner gives PManager only its SHA-256:

   ```bash
   printf %s "$WORKER_TOKEN" | shasum -a 256
   ```

4. PManager puts that hash in `supabase/ops/worker-token.sql` and runs it with the Supabase admin
   `sql` command.

A new token needs both steps again: the new secret on Render, and its hash pinned. Until both are
done, the worker logs `Bad worker token.` and claims nothing.

`test/secrets.test.js` fails if the token or its hash is in any committed file. Run it with the
real token in the environment before a release:

```bash
WORKER_TOKEN="$WORKER_TOKEN" node --test test/secrets.test.js
```

## 3. Render

The worker starts Chromium for every run, so it cannot share `backend-hub` (one 512 MB instance
shared with other apps). It needs a service of its own, built from this repository's
`Dockerfile` (on the official Playwright image `mcr.microsoft.com/playwright:v1.63.0-noble`).
`render.yaml` describes it:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://auth.hintwise.org` |
| `SUPABASE_ANON_KEY` | the public anon key, from claude-built-apps `platform/supabase.json` |
| `WORKER_TOKEN` | the token from step 2 (secret) |
| `ALLOWED_ORIGINS` | `https://screen-reader-journeys.hintwise.org` |
| `ALLOWED_TARGET_HOSTS` | the sites the server may test, as exact hosts, or `*` for any public site (see below). Empty means none |

- **Defaults.** `RUN_TIMEOUT_SECONDS` (900) and `POLL_INTERVAL_SECONDS` (5) are set in
  `render.yaml`, and `SUPABASE_TIMEOUT_SECONDS` defaults to 30.
- **Set for you.** Render sets `PORT`, and the Docker image sets `RUN_AS_UID` and `RUN_AS_GID`.
- **`CHROMIUM_SANDBOX`:** leave it unset with exact hosts only; set it to `true` with `*` or a
  wildcard rule, which need it (see [Security](#security)).
- **Plan: free** (the owner, 23 November 2026). It costs nothing, and has 0.1 CPU and 512 MB.
  Keep one instance, since the worker runs one run at a time. A paid plan needs the owner's yes.
  - **It sleeps** after 15 minutes without requests. A queued run waits until the next request
    wakes the service. Waking takes Render's own start, then about 7 seconds for the server to
    listen, then about 9 seconds for Chromium's first start (both measured at 0.1 CPU).
  - **A run can be interrupted.** The dashboard asks for a run's status every 4 seconds while its
    page is open, which keeps the service awake. If nobody has the page open, the service may go
    to sleep mid-run: the run then goes back in the queue and starts again on the next visit.
    The run page and the new-run form both say so.
  - **Measured** (23 November 2026): 6 journeys in both modes (12 journey runs), against a local
    copy of the STEM-Accessibility preview with the mock backend, through the real worker path
    (the run process and Chromium), with cgroup limits:

    | CPU and memory | Time | Peak memory of the run |
    |---|---|---|
    | 4 CPUs, no limit | 172 s | 292 MB |
    | 0.5 CPU, 512 MB | 188 s | 276 MB |
    | 0.1 CPU, 512 MB | 362 s | 263 MB |

    Each finished all 12 journey runs, with the same results, and none ran out of memory. The
    idle server adds about 146 MB, so the instance peaks at about 410 to 440 MB of 512 MB.
  - **The headroom is about 70 to 100 MB**, and a heavy site may run out of memory. The run
    then fails: at once if only the browser is stopped, or, if the whole service restarts, once
    its `RUN_TIMEOUT_SECONDS` and ten minutes have passed. Either way it can be run again. Render's
    paid Starter plan also has 512 MB, so paying buys speed, not memory.
- **Check it:**

  ```bash
  curl -s https://<service>.onrender.com/health
  # {"status":"ok","version":"0.1.0"}
  ```

  The log shows the number of journeys, the allowed sites and the allowed origins. A missing or
  forbidden setting stops the service at start-up, with a list of what is wrong.

  **On the first deploy, check that the worker started.** If the log says
  `not starting the worker: the host's fs.suid_dumpable is ...` or
  `not starting the worker: cannot read /proc/sys/fs/suid_dumpable (...)`, the host would let a
  run trace the helper that stops its processes, or this cannot be checked (see Security), so
  the service exits and runs nothing. That is a
  setting of Render's host, not of the image: it cannot be fixed from here, so ask Render, or run
  the worker on another host.

## 4. Netlify

`netlify.toml` sets the base directory `web`, the build command `npm run build` and the publish
directory `dist`. The owner imports the repository once, with Deploy Previews and branch deploys
turned off, because every build costs credits. Docs-only commits carry `[skip netlify]`.

| Variable | Value | Where |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://auth.hintwise.org` | `netlify.toml` |
| `VITE_SUPABASE_ANON_KEY` | the public anon key. The build refuses a service-role key | `netlify.toml` |
| `VITE_API_URL` | the Render service's address, without a trailing slash | the site's environment variables |
| `VITE_SITE_URL` | `https://screen-reader-journeys.hintwise.org`, the dashboard's one address; production builds only | `netlify.toml`, `[context.production.environment]` |

- **One address.** Opened anywhere else (over http, under the netlify.app name, or at a deploy's
  own address), the page first moves to `VITE_SITE_URL`, keeping its path, query and hash, and
  sign-in always returns there (`web/src/canonical.ts`). Otherwise Supabase would refuse the return
  address and fall back to the shared project's `site_url`, another app. The move is made by
  `dist/site.js`, which the build writes and puts first in the page, before the analytics script,
  so a moved visit counts once; `src/main.ts` moves the page too if `site.js` did not run.
  - A production build without it, or with anything but an https address on `hintwise.org`,
    fails.
  - A Deploy Preview or branch deploy (both off) is built without it, so it shows its own code
    where it is; sign-in cannot return to such an address in any case.
  - Leave it empty for local work (`.env.example`), or a local page would move to the live site.
    The dashboard test sets it empty, whatever the shell says.

- **The build:** `tsc` and `vite build`.
- **The Content-Security-Policy** goes in `_headers`. It allows exactly the Supabase URL and the
  API, Cloudflare Turnstile (which sign-in may ask for), and the page's inline styles by hash:
  the HintWise footer's, the sign-in panel's and the Google G's.
- **`licenses.txt`:** the bundled packages and their licences.
- **The other security headers** are in `netlify.toml`, which also sends
  `screen-reader-journeys.netlify.app` to the hintwise.org address.

The page carries the HintWise footer byte for byte, the HintWise favicon and `hw-events.js`, the
platform's cookieless visit counter. Its privacy note says what is stored. The tests in
`web/test/hintwise.test.ts` pin all of these.

## 5. Smoke test

```bash
API=https://<service>.onrender.com
curl -s $API/health                     # {"status":"ok",...}
curl -s $API/journeys                   # the journeys, modes and allowed sites
curl -s -X POST $API/runs -H 'Content-Type: application/json' -d '{}'
                                        # 401: a token is needed
```

Then in the dashboard:

1. Sign in. The page shows *Runs*.
2. Start a run with the address of an allowed site, *Home page: Tab order* and *Keyboard walker*.
   The run page shows *Waiting*, then *Running*, then *Finished*, and its status line says so.
3. Download `summary.md` and a report from the run page.
4. Try a site that is not allowed, such as `https://example.com`. The form says which sites are.
5. Optionally, sign in as a second person. They do not see the first person's runs.

## 6. Local development and tests

- **`npm test`** covers:
  - the server: the allowlist, validation, the API, and the worker against local fixture sites,
    with a fake Supabase client that models the `worker_*` functions;
  - the dashboard, built with Vite and walked by keyboard with this tool, including the
    emailed-code sign-in, under its own Content-Security-Policy and at 375 px. It needs
    `npm ci --prefix web` first.
- **The gates before every push**, which CI runs too:
  - at the root, for the server and the tool: `npm run lint`, `npm run typecheck` (tsc checking
    the JavaScript from its JSDoc) and `npm run coverage` (every test, failing if `server/` falls
    under 85% of lines, branches or functions). Node counts only files that ran, so
    `test/server-index.test.js` starts `server/index.js` as a real process, and it is measured
    too. CI runs coverage as an ordinary user and then, as root, the root-only tests of
    `test/server-reports.test.js` and `test/server-worker.test.js`, which coverage does not count.
    Run as root, `test/server-index.test.js` starts the server as `nobody`, and skips those tests,
    saying why, when `nobody` cannot read the checkout (one under `/root`, say). Run one suite at
    a time on a machine: the root-only tests stop every process of the run's user, so two suites
    at once (two worktrees, or a reviewer's mutations beside a coverage run) fail each other's;
  - in `web/`, for the dashboard: `npm run lint`, `npm run typecheck`, `npm run coverage` (at
    least 85%, under jsdom with fakes) and `npm run build`.
- **`npm run test:sql`** applies the migrations twice to a throwaway local PostgreSQL, on a stub of
  Supabase's roles and `auth`. It needs `initdb`, `pg_ctl` and `psql`. It checks the grants, row
  level security, the per-person limit, the token check, each worker function, account deletion,
  and two workers claiming at once.

To run the whole service locally against the Supabase CLI's local stack (`npx supabase start`,
which needs Docker):

1. Add `app_screen_reader_journeys` to the API schemas in `supabase/config.toml`.
2. Pin a local token's hash with `psql`, as `supabase/ops/worker-token.sql` does.
3. Fill in `.env` from `.env.example`, with that token as `WORKER_TOKEN`.

Sign-in returns only to `https://*.hintwise.org`, so a local dashboard (`cd web && npm run dev`)
cannot complete a real sign-in. Use the API with a token from the local stack instead.

## Which sites the server will test

`ALLOWED_TARGET_HOSTS` is a comma-separated list. An empty list allows nothing.

| Rule | Allows | Does not allow |
|---|---|---|
| `stem-accessibility.example.org` | `https://` and `http://` on that host, default port | `www.stem-accessibility.example.org`, other ports |
| `*.vercel.app` | `https://` on any subdomain, e.g. `https://frontend-git-x.vercel.app` | `vercel.app` itself, `evilvercel.app`, `vercel.app.evil.com`, `http://` |
| `127.0.0.1:4173` | that address and port, `http://` or `https://` | other ports, `localhost`, other loopback addresses |
| `*` | any public site: `https://` or `http://`, ports 80 and 443 only | the addresses below, and other ports |

**`*`, any public site.** Any signed-in person may then test any public address. It can stand
alone, or with exact rules (`*, 127.0.0.1:4173`), which stay trusted as listed. Under `*` the
server refuses, when the run is queued, again when it starts, and at every connection the
browser makes (redirects and subresources included):

- loopback, private networks, link-local (and so cloud metadata, `169.254.169.254` and
  `fd00:ec2::254`), carrier-grade NAT, multicast, unspecified (`0.0.0.0`, `::`), documentation
  and other reserved ranges, IPv4-mapped and other IPv6 forms that embed an IPv4 address;
- a host name that resolves to any such address, even alongside public ones. The proxy resolves
  each host once and connects to the address it checked, so a changed DNS answer cannot redirect
  the connection;
- `localhost` names, and single-label hosts such as `https://intranet/`, which would use the DNS
  search path;
- ports other than 80 and 443.

`*` never makes a host "listed exactly": everything it admits is checked like that. It, and any
wildcard rule, also needs Chromium's sandbox (`CHROMIUM_SANDBOX=true`, checked when the worker
starts; see Security). A person may also start at most 10 runs a day (UTC, `0002_daily_cap.sql`),
everyone together 40, and a person may have at most 3 waiting or running. A run may move at most
100 MB through the proxy, and look up at most 500 host names.

The server also refuses:

- addresses with a user name or password;
- IP addresses and `localhost`, unless listed exactly (under `*`, public IP addresses are
  allowed);
- for a connection to a host that is not listed exactly, any port but 80 and 443, in every mode,
  so a tested page cannot use the server to reach other services on public hosts (so a wildcard
  rule may not name a port either);
- journeys that are not files in its own `targets/`. People choose journeys by path, so the
  server never runs code a person sends.

It checks a run again before running it, because a signed-in person can also insert a queued run
straight into the table.

`*.vercel.app` admits any Vercel deployment, including other people's, so any wildcard rule, like
`*`, needs Chromium's sandbox (see Security). Prefer exact hosts, or a domain only you control,
where you can.

## Operations

- **A run's progress.** While a run is running, its page shows which journey and mode it is on
  ("Running 2 of 4: …"), the results so far, the step, and the time against the time limit. The
  worker holds this in memory, from the run process's checked messages (a "progress" message
  when a journey and mode starts, and its step at most once a second; the worker passes on at
  most one step each half second, resetting at each journey and mode, and a run that sends more
  than 5000 progress messages, or for a run longer than 40 minutes twice what it could send, ends
  as malformed), and the API serves it to the run's owner only (`GET /runs/:id/progress`, which
  reads the run through the person's own client first). Between a result and the next start it
  names no journey ("starting"), and while the reports are saved it says so, keeping the results.
  The time is the server's own (`elapsed_s`), so the visitor's clock does not matter. Nothing is
  stored: a server that is not running the run answers `{ "progress": null }`. The page's status
  line says the journey and the results when they change, not the step or the clock; opening
  the page of a running run says them at once. When a run starts and there is no progress to
  say yet (or the request fails), it says "The run is running." instead.

- **Updates.**
  - Netlify builds on every push to `main`. Render deploys as its service is set up.
  - A schema change is a new migration file. It is applied before the code that needs it is
    deployed, and an applied file never changes.
  - When Playwright is updated, change the `Dockerfile`'s image tag to the same version.
- **Timeouts.** A run that takes longer than `RUN_TIMEOUT_SECONDS` is stopped, browser included.
  The journeys that finished keep their results.
  - Each journey opens its page when the page's load event fires, within 120 s, then waits at most
    15 s more for the network to go quiet (and up to 20 s more for a journey's `ready` element),
    all within the run's `RUN_TIMEOUT_SECONDS` (`src/journey.js`, `LOAD_TIMEOUT_MS` and
    `IDLE_WAIT_MS`). A page that keeps a request open (an ad or analytics request, a long poll, a
    stream) is tested anyway, and its reports (Markdown and HTML), its transcript and the run's
    summary say the page may still have been loading and the walk may be incomplete. A page
    whose load event never fires is not tested, and the run's other journeys and modes that open
    that same page are not run either. Each gets a report that says why ("Not run: … did not load
    in an earlier journey"); the run's page shows that reason under the result, and
    `summary.md` lists it under Errors. The worker is free again after one load timeout (120 s)
    for each distinct start page that does not load: about two minutes for a run of one
    journey, and about ten for the whole catalog (five start pages), not after the whole run
    timeout (R22.3-2). Only the opening load counts: a later navigation that times out does not.
  - When Render restarts the service (a deploy, say), the run in progress goes back in the queue.
  - A run left `running` by a service that crashed is marked failed ten minutes after its timeout.
- **Limits.**
  - Three runs waiting or running per person (`limit_active_runs`); ten started per UTC day per
    person, and forty in all (`limit_daily_runs`, 0002). Each answers 429 with the reason.
  - Per run, through the network guard: at most 100 MB, both directions together, counted on
    the browser's own connections to it (request lines, headers, bodies, uploads and tunnels
    alike; checked every 50 ms, so a run may pass it by what moves in that time). Then every
    connection is closed and new ones are refused; the run's blocked requests say so first, also
    when the run ends early (a timeout, or an error that ends the job, such as a journey that
    cannot be loaded), and the server logs one line. A run stopped because the server is
    shutting down (a deploy) is put back in the queue and starts again, so its summary is the new
    run's. After a stop, no new journey or mode starts, and a result the stop cut short is not
    counted. A run may also look up at most 500 host names, each counted once. A lookup that fails
    for a reason that may pass (a busy resolver) is tried again, at most 4 times in all; one that
    finds no such host is kept, so a page that keeps asking for a dead host costs one lookup.
    Each refusal entry is cut to 2000 characters in the middle, so its reason shows.
  - Per run: one result for each of the run's journeys and modes (a unique constraint), and at
    most 200 report files and 20 MiB of reports, of at most 2 MiB each.
  - A file is left out if it is a link or another non-file, is over 2 MiB, has a name the
    database does not take, or is refused by the database (a cap, a check, or text it cannot
    hold), or once the save is full or has taken too long. The run's summary counts every such
    file (`skipped_count`) and names up to 20 (`skipped_files`, each cut to 200 characters, those
    left out one by one first), and the run still finishes. Any other error while saving fails
    the run. NUL characters in a report become U+FFFD.
- **Retention** (PManager's decision, 23 November 2026; the privacy note on the page says so):
  - each person keeps their 20 latest runs; queueing a new one deletes their oldest finished
    runs beyond that;
  - finished runs older than 30 days are deleted, by `worker_prune_runs`, which the worker calls
    about once an hour while the service is awake. A failed prune is logged and does not stop the
    queue.

  Deleting a run, or the account, deletes its results and reports at once.
- **Logs.** Render's log shows each run starting and ending. The network guard's refusals are
  stored with the run (`summary.blocked_requests`) and shown on the run page. The server keeps
  at most 200 different ones a run, plus the byte limit's; the summary shows the first 50, the
  byte limit's first, each cut to 300 characters and each once as cut, and when it shows fewer
  than there were, it counts them (`summary.blocked_count`, "And N more." on the page). When the
  server left some out past its 200, that count is a floor (`summary.blocked_more`, "And at least
  N more.").

## Security

- **Keys.**
  - The server holds the public anon key and `WORKER_TOKEN`, and never the service-role key.
  - A leaked `WORKER_TOKEN` lets its holder claim, fill in, finish or requeue runs. It cannot read
    anyone's runs, results or reports.
  - **The run's files are not trusted.** The run's user (`RUN_AS_UID`) can write anything into
    its reports folder, and the server runs as root. So (`server/reports.js`,
    `server/report-child.js`):
    - **the server never reads or deletes the run's files as root.** A short child process that
      runs as the run's user lists and reads the reports, and sends them to the server over IPC.
      The server checks each answer (its shape, and paths inside the folder), and the child's
      answers together have a time limit of two minutes (the database's writes in between do not
      count), and the whole save, writes included, five minutes. Files still waiting then, and
      every file after the 200th, are left out without asking the child or the database.
      Another child empties `reports/` and `home/` at the end. Root then removes the two folders
      and the work folder one at a time with `rmdir`, which never follows a link and fails on a
      folder that is not empty. Whatever a process of that user might
      still do, reading and deleting reach only what that user may anyway. The child first makes
      `reports/`, `home/` and every folder of that user's below them writable again, so a folder
      the run made read-only does not stay. **If anything is still left** (or root's `rmdir`
      fails), it would be in `/tmp` as that user's, for later runs to read: root takes
      `reports/` and `home/` and closes them to everyone else (mode 0700), and the server exits,
      as after a failed stop (below);
    - the run's work folder belongs to the server (mode 0755); only `reports/` and `home/` inside
      it are the run user's, so the run cannot rename or replace them. Before reading, the
      server checks that `reports/` is still the folder it made: not a link, the same inode, the
      same owner;
    - before each run, before its reports are read, and when it ends on any path, the server
      ends every process of that user. Each pass kills every listed pid from root, which they
      cannot block, and then everything of that user at once: a helper calls
      `kill(-1, SIGKILL)` once as that user, which the kernel sends to every process of the
      user it can signal. The helper starts as root and becomes the user inside itself, with no
      exec afterwards, so the kernel marks it non-dumpable and a process of that user cannot
      trace it or fake its result. That holds only while the host's `fs.suid_dumpable` is 0 or 2,
      so **with `RUN_AS_UID` set, the worker does not start** (the server exits with a message)
      if `/proc/sys/fs/suid_dumpable` reads anything else or cannot be read, and the helper
      reads it again each time before it becomes the user: for anything else it gives no proof,
      so the stop fails as below. Root ends the
      helper after a second if it is stopped. The stop returns only after a pass whose helper ran
      to the end and a scan after it that finds no live thread of that user; one empty scan is
      never taken as proof;
    - **if that stop does not succeed** (within 10 seconds), the run fails or goes back in the
      queue, the server reads and deletes nothing of it, and it exits. With tini as PID 1 the
      whole container then stops, which ends every process in it, and Render starts a fresh one;
    - the listing does not follow links, and keeps regular files only;
    - each file is opened with `O_NOFOLLOW`, and the open handle is checked: a regular file, owned
      by the run's user, with a single link (so not a hard link to another file), of at most
      2 MiB. The read goes no further than that, and a file whose folder resolves outside the
      reports folder as recorded when it was made is refused.

    So a link to `/proc/self/environ`, a folder swapped for a link, a hard link, or a process
    left running never makes the server read or delete a file the run could not.
  - **PID 1** in the image is `tini` (`ENTRYPOINT ["/usr/bin/tini", "-s", "--"]`), which reaps
    orphaned processes, so a run's leftovers do not pile up as zombies (`-s` keeps it reaping
    even if the host puts another init in front of it). It passes Render's SIGTERM on to the
    server, which then puts a run in progress back in the queue, and it exits when the server
    exits.
  - **`RUN_AS_UID` must be a user nothing else uses** in the container: the server ends every
    process of that user. The image's `runner` (10001) is used only by runs. Outside Docker, and
    for the root-only tests, use a user of its own.
  - The run process that drives the browser gets only a short list of harmless variables (`PATH`,
    `HOME`, `TMPDIR`, the locale and time zone, `NODE_ENV` and `PLAYWRIGHT_BROWSERS_PATH`). It runs as `runner`, an unprivileged user, while the
    server runs as root. So even a page that breaks out of Chromium cannot read the server's
    environment through `/proc`.
- **Network guard.** Pages under test are untrusted, and their scripts run in the server's
  Chromium.
  - Every connection the browser makes goes through a proxy local to the run. The proxy refuses
    loopback, private-network, link-local (cloud metadata) and other reserved addresses, and any
    port but 80 and 443, unless the host is listed exactly in `ALLOWED_TARGET_HOSTS` (`*` lists
    no host exactly).
  - It resolves each host itself and connects to the address it checked, so a DNS answer that
    changes cannot redirect it.
  - Requests that a journey's own `setup` answers (the STEM-Accessibility mock) never leave the
    browser, so mocks still work.
  - QUIC is turned off, and WebRTC may not use UDP, since neither would go through the proxy.
  - What the run process sends back is checked: results only for the run's own journeys and
    modes, of the right shape, and only the fields the worker uses are kept; nothing is read
    after it is done or has failed, or after something malformed (which ends the run as an
    error). Results already on their way when its time is up are still taken until it has
    ended. It has no IPC channel: the job goes in on stdin, and its messages come back on a
    pipe, one JSON line each, at most 262,144 characters a line, so it cannot make the server
    hold more than that at once, plus at most one small result for each journey and mode and
    200 different refusals of at most 2000 characters (and the byte limit's). Its own output
    reaches the log quoted, one line at a time, at most 2000 characters a line and 1000 lines a
    run, stdout and stderr together.
- **Chromium's sandbox** (`CHROMIUM_SANDBOX`) is off by default: it needs user namespaces,
  which many container hosts do not allow.
  - **Without it**, a Chromium exploit in a tested page runs as `runner` inside the container. It
    cannot read the server's environment, but the network guard is a process like any other, not
    a wall: the exploit can use the container's network without it, Render's private network
    included. With exact hosts only, that risk is limited to the sites listed, so keep the list
    short and trusted.
  - **With `*` or a wildcard rule, the sandbox is required.** Anyone signed in may then send the
    browser to any page (`*`), or to any page under a shared domain (`*.vercel.app`, where anyone
    may host one). So the worker then starts only if `CHROMIUM_SANDBOX=true` and a sandboxed
    Chromium starts here, as `runner` (`server/sandbox-probe.js`, tried once at start-up).
    Otherwise the log says `not starting the worker: ALLOWED_TARGET_HOSTS with "*" or a wildcard
    rule needs Chromium's sandbox ...` and the server exits. A run is also refused, and the run
    process refuses its job, without the sandbox. Whether Render's host allows it is known only by
    trying.
  - **In every mode**, keep Playwright and the image up to date: within a week of a Chromium
    security release.
- **Errors** shown to people are short. Database details go only to Render's log.
- **Reports** are fetched one at a time, when their download button is pressed, and always saved
  as `application/octet-stream`. A report is never opened as a page at the dashboard's address,
  next to the person's session.
- **CORS** limits which websites may call the API from a browser. It is not authentication: every
  call that reads or creates runs needs a valid Supabase access token.
