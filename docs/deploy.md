# Deploying the hosted service

The tool also runs as a small hosted service, a HintWise app at
`https://screen-reader-journeys.hintwise.org`. People sign in to a dashboard, pick a site and
some journeys, and read the transcripts when the run finishes. It follows claude-built-apps
`docs/new-app-guide.md`, option B (an app in its own repository).

```
  Browser ──────────────► Netlify: web/ (static dashboard)
     │                        │
     │ sign in, list runs,    │ GET /journeys, POST /runs, GET /runs/:id
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

1. **Migrations.** `supabase/migrations/0001_runs.sql` creates everything in the schema
   `app_screen_reader_journeys`, idempotently:
   - **`runs`.** Signed-in people read their own, queue new ones (status `queued` only, at most
     three waiting or running) and delete their own.
   - **`run_results` and `run_reports`.** People read their own.
   - **`worker_config`.** The SHA-256 of `WORKER_TOKEN`. Nobody reads it through the API.
   - **The worker functions**, each `security definer` with `search_path = ''`, which only `anon`
     may call: `worker_claim_next_run`, `worker_fail_stale_runs`, `worker_prune_runs`,
     `worker_requeue_run`, `worker_save_report`, `worker_add_results` and `worker_finish_run`.
     Each checks the token's SHA-256 against `worker_config` and refuses every token until that
     row exists.
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
| `ALLOWED_TARGET_HOSTS` | the sites the server may test, as exact hosts (see below). Empty means none |

- **Defaults.** `RUN_TIMEOUT_SECONDS` (900) and `POLL_INTERVAL_SECONDS` (5) are set in
  `render.yaml`, and `SUPABASE_TIMEOUT_SECONDS` defaults to 30.
- **Set for you.** Render sets `PORT`, and the Docker image sets `RUN_AS_UID` and `RUN_AS_GID`.
- **Leave unset:** `CHROMIUM_SANDBOX` (see [Security](#security)).
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

## 4. Netlify

`netlify.toml` sets the base directory `web`, the build command `npm run build` and the publish
directory `dist`. The owner imports the repository once, with Deploy Previews and branch deploys
turned off, because every build costs credits. Docs-only commits carry `[skip netlify]`.

| Variable | Value | Where |
|---|---|---|
| `VITE_SUPABASE_URL` | `https://auth.hintwise.org` | `netlify.toml` |
| `VITE_SUPABASE_ANON_KEY` | the public anon key. The build refuses a service-role key | `netlify.toml` |
| `VITE_API_URL` | the Render service's address, without a trailing slash | the site's environment variables |

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
    under 85% of lines, branches or functions);
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

The server also refuses:

- addresses with a user name or password;
- IP addresses and `localhost`, unless listed exactly;
- journeys that are not files in its own `targets/`. People choose journeys by path, so the
  server never runs code a person sends.

It checks a run again before running it, because a signed-in person can also insert a queued run
straight into the table.

`*.vercel.app` admits any Vercel deployment, including other people's. Prefer exact hosts, or a
domain only you control, where you can.

## Operations

- **Updates.**
  - Netlify builds on every push to `main`. Render deploys as its service is set up.
  - A schema change is a new migration file. It is applied before the code that needs it is
    deployed, and an applied file never changes.
  - When Playwright is updated, change the `Dockerfile`'s image tag to the same version.
- **Timeouts.** A run that takes longer than `RUN_TIMEOUT_SECONDS` is stopped, browser included.
  The journeys that finished keep their results.
  - When Render restarts the service (a deploy, say), the run in progress goes back in the queue.
  - A run left `running` by a service that crashed is marked failed ten minutes after its timeout.
- **Limits.**
  - Three runs waiting or running per person (`limit_active_runs`).
  - Per run: one result for each of the run's journeys and modes (a unique constraint), and at
    most 200 report files and 20 MiB of reports, of at most 2 MiB each.
  - A file is left out if it is a link or another non-file, is over 2 MiB, has a name the
    database does not take, or is refused by the database (a cap, a check, or text it cannot
    hold). The run's summary lists it under `skipped_files`, and the run still finishes. Any
    other error while saving fails the run. NUL characters in a report become U+FFFD.
- **Retention** (PManager's decision, 23 November 2026; the privacy note on the page says so):
  - each person keeps their 20 latest runs; queueing a new one deletes their oldest finished
    runs beyond that;
  - finished runs older than 30 days are deleted, by `worker_prune_runs`, which the worker calls
    about once an hour while the service is awake. A failed prune is logged and does not stop the
    queue.

  Deleting a run, or the account, deletes its results and reports at once.
- **Logs.** Render's log shows each run starting and ending. The network guard's refusals are
  stored with the run (`summary.blocked_requests`) and shown on the run page.

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
      The server checks each answer (its shape, and paths inside the folder), and the whole
      read has a time limit. Another child empties `reports/` and `home/` at the end. Root then
      removes the two folders and the work folder one at a time with `rmdir`, which never follows
      a link and fails on a folder that is not empty. Whatever a process of that user might
      still do, reading and deleting reach only what that user may anyway. The child first makes
      the run's own folders writable again, so a folder the run made read-only does not stay.
      **If anything is still left**, it would be in `/tmp` as that user's, for later runs to
      read: root takes `reports/` and `home/` and closes them to everyone else (mode 0700), and
      the server exits, as after a failed stop (below);
    - the run's work folder belongs to the server (mode 0755); only `reports/` and `home/` inside
      it are the run user's, so the run cannot rename or replace them. Before reading, the
      server checks that `reports/` is still the folder it made: not a link, the same inode, the
      same owner;
    - before each run, before its reports are read, and when it ends on any path, the server
      ends every process of that user. Each pass kills every listed pid from root, which they
      cannot block, and then everything of that user at once: a helper calls
      `kill(-1, SIGKILL)` once as that user, which the kernel sends to every process of the
      user it can signal. The helper
      starts as root and becomes the user inside itself, with no exec afterwards, so a process
      of that user can never trace it and fake its result. Root ends the helper after a second
      if it is stopped. The stop returns only after a pass whose helper ran to
      the end and a scan after it that finds no live thread of that user; one empty scan is
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
    loopback, private-network, link-local (cloud metadata) and other reserved addresses, unless
    the host is listed exactly in `ALLOWED_TARGET_HOSTS`.
  - It resolves each host itself and connects to the address it checked, so a DNS answer that
    changes cannot redirect it.
  - Requests that a journey's own `setup` answers (the STEM-Accessibility mock) never leave the
    browser, so mocks still work.
  - QUIC is turned off, and WebRTC may not use UDP, since neither would go through the proxy.
- **Chromium's sandbox** is off by default, because it cannot start inside a standard Docker
  container (Render's included).
  - A Chromium exploit in a tested page would therefore run as `runner` inside the container. It
    could not read the server's environment, but it could use the container's network outside the
    proxy.
  - So keep the list of allowed sites short and trusted (exact hosts), and keep Playwright and
    the image up to date.
  - Set `CHROMIUM_SANDBOX=true` only on a host where Chromium's sandbox works.
- **Errors** shown to people are short. Database details go only to Render's log.
- **Reports** are fetched one at a time, when their download button is pressed, and always saved
  as `application/octet-stream`. A report is never opened as a page at the dashboard's address,
  next to the person's session.
- **CORS** limits which websites may call the API from a browser. It is not authentication: every
  call that reads or creates runs needs a valid Supabase access token.
