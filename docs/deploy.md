# Deploying the hosted service

The tool can run as a small hosted service: people sign in to a dashboard, pick a site and some
journeys, and read the transcripts when the run finishes. It uses three services:

```
  Browser ──────────────► Netlify: web/ (static dashboard)
     │                        │
     │ sign in, list runs,    │ GET /journeys, POST /runs, GET /runs/:id
     │ signed report links    ▼
     │                    Render: server/ (Docker: HTTP API + worker + Chromium)
     ▼                        │  the API acts as the signed-in user (row-level security);
  Supabase: Auth, Postgres, ◄─┘  the worker claims runs and uploads reports with the
  Storage (reports bucket)       service role key
```

| Where | What runs | Which Supabase key |
|---|---|---|
| Supabase | Auth (magic links), the `runs` and `run_results` tables, the private `reports` bucket | — |
| Render | `server/index.js`: the API and, in the same process, the worker that runs journeys in walker and virtual modes | anon key (to check tokens and act as users) and **service role key** (the worker) |
| Netlify | `web/`: plain HTML, CSS and JavaScript, bundled with supabase-js | anon key only; it is public by design |

The `voiceover` mode needs a Mac, so the service runs only `walker` and `virtual`; use the CLI or
the VoiceOver workflow for the rest.

## Before you start

- Accounts on Supabase, Render and Netlify, each with access to this GitHub repository. Their free
  plans are enough to try it (see the plan notes below).
- The [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started):
  `npx supabase --version` works without installing it.
- A list of the sites the service may test. It refuses every other site; see
  [Which sites the server will test](#which-sites-the-server-will-test).

Deploy in this order: Supabase, then Render, then Netlify, then go back to Supabase and Render to
fill in the Netlify address.

## 1. Supabase

1. **Create a project** in the [Supabase dashboard](https://supabase.com/dashboard). Choose a region
   near Render's (`render.yaml` uses Frankfurt; use `eu-central-1`, or change both). Keep the
   database password somewhere safe.
2. **Note three values** from *Project Settings → API Keys* (and *Data API* for the URL):
   - the project URL, `https://<project-ref>.supabase.co`;
   - the **anon** key (called *publishable* in newer projects): public, goes to Render and Netlify;
   - the **service_role** key (*secret*): full access to the database, goes **only** to Render.

   Either the legacy JWT keys or the newer `sb_publishable_…` and `sb_secret_…` keys work.
3. **Apply the migration**, from the repository root:

   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```

   `supabase/migrations/20261123120000_runs.sql` creates:
   - `runs` and `run_results`, with row-level security: signed-in users read their own runs and
     results and queue new runs (status `queued` only); only the service role changes anything;
   - a limit of three runs waiting or running per user;
   - `claim_next_run()`, which only the service role may call;
   - the private `reports` storage bucket, and a policy that lets a user read the files under
     `<run_id>/` for their own runs only.

   Check in the dashboard: *Table Editor* shows both tables with RLS enabled, and *Storage* shows a
   private `reports` bucket. (You do not need to create the bucket by hand.)
4. **Auth URLs** (*Authentication → URL Configuration*). Fill these in once Netlify has given you
   the site's address (step 3):
   - *Site URL*: `https://<site>.netlify.app`
   - *Redirect URLs*: `https://<site>.netlify.app/**`, plus
     `https://deploy-preview-*--<site>.netlify.app/**` if you use deploy previews, and
     `http://127.0.0.1:5173/**` for local development.
5. **Who may sign in.** By default anyone with an email address can create an account with a
   magic link, and every account can make the server open the allowed sites in a browser. For a
   private service, turn off *Allow new users to sign up* (*Authentication → Sign In / Providers*)
   and invite people from *Authentication → Users*. The dashboard tells others to ask for an
   invitation.
6. **Email.** Supabase's built-in email sender is for trying things out and sends only a few
   emails an hour. Set up your own SMTP server (*Authentication → Emails → SMTP Settings*) before
   other people use the service.

The dashboard uses the PKCE flow, so a magic link must be opened in the browser that asked for it.

## 2. Render

1. In the [Render dashboard](https://dashboard.render.com), choose *New → Blueprint*, connect this
   repository and the branch to deploy. Render reads `render.yaml` and proposes one web service,
   `screen-reader-journeys`, built from the `Dockerfile` (on the official Playwright image
   `mcr.microsoft.com/playwright:v1.63.0-noble`).
2. Render asks for the values marked `sync: false`:

   | Variable | Value |
   |---|---|
   | `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `SUPABASE_ANON_KEY` | the anon (publishable) key |
   | `SUPABASE_SERVICE_ROLE_KEY` | the service role (secret) key |
   | `ALLOWED_ORIGINS` | the dashboard's origin, `https://<site>.netlify.app`. Until Netlify exists, put any `https://` origin and change it later. Separate several with commas. |
   | `ALLOWED_TARGET_HOSTS` | the sites the server may test, e.g. `*.vercel.app` (see below). Empty means none. |

   `RUN_TIMEOUT_SECONDS` (900) and `POLL_INTERVAL_SECONDS` (5) have defaults in `render.yaml`.
   Render sets `PORT` itself. Leave `CHROMIUM_SANDBOX` unset (see [Security](#security)).
3. **Plan.** `render.yaml` starts on the *free* plan, which costs nothing but sleeps after 15
   minutes without requests (a queued run waits until the next request wakes it, which takes about
   a minute) and has 512 MB of memory, which Chromium can exceed on large pages. For regular use,
   change `plan:` to `standard` (2 GB). Keep one instance: the worker runs one run at a time.
4. Apply the Blueprint and wait for the first deploy. Then check:

   ```bash
   curl -s https://<service>.onrender.com/health
   # {"status":"ok","version":"0.1.0"}
   ```

   The log shows the number of journeys, the allowed sites and the allowed origins. A missing
   setting stops the service at start-up with a list of what is wrong.

## 3. Netlify

1. In the [Netlify dashboard](https://app.netlify.com), choose *Add new site → Import an existing
   project* and pick this repository. Netlify reads `netlify.toml` (base `web`, build
   `npm run build`, publish `dist`); leave those fields as they are.
2. Before the first deploy, add three environment variables (*Site configuration → Environment
   variables*):

   | Variable | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_ANON_KEY` | the anon (publishable) key. The build refuses a service role key. |
   | `VITE_API_URL` | `https://<service>.onrender.com`, without a trailing slash |

   The build writes them to `config.js`, and writes a Content-Security-Policy that allows exactly
   these two origins to `_headers`. `netlify.toml` adds the other security headers.
3. Deploy, and note the site's address.
4. Go back and use that address:
   - in Supabase, as the *Site URL* and in the *Redirect URLs* (step 1.4);
   - in Render, as `ALLOWED_ORIGINS` (Render redeploys when you save).

A custom domain needs the same two changes for its origin.

## 4. Smoke test

```bash
API=https://<service>.onrender.com
curl -s $API/health                     # {"status":"ok",...}
curl -s $API/journeys                   # the journeys, modes and allowed sites
curl -s -X POST $API/runs -H 'Content-Type: application/json' -d '{}'
                                        # 401: a token is needed
```

Then in the dashboard:

1. Sign in with your email address and open the link in the same browser. The page shows *Runs*.
2. Start a run: the site address of an allowed site, *Home page: Tab order*, *Keyboard walker*.
   The run page shows *Waiting*, then *Running*, then *Finished* (and says so in its status line).
   On the free plan the first request may take a minute while the service wakes.
3. Download `summary.md` and a report from the run page.
4. Try a site that is not allowed, such as `https://example.com`: the form says which sites are.
5. In Supabase, the `runs` row is `done`, `run_results` has a row, and *Storage → reports* has a
   folder named after the run.
6. Optionally, sign in as a second user: they do not see the first user's runs.

To call the API yourself, copy your access token from the dashboard's browser console (it is a
credential; do not share it):

```js
JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.endsWith("-auth-token")))).access_token
```

```bash
curl -s -X POST $API/runs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"base_url":"https://<allowed-site>","journeys":["targets/generic/home-tab-order.journey.js"],"modes":["walker"]}'
curl -s $API/runs/<id> -H "Authorization: Bearer $TOKEN"
```

## 5. Local development

With Docker, the Supabase CLI runs the whole Supabase stack locally:

```bash
npm ci
npx supabase start          # Postgres, Auth, Storage and the rest; applies supabase/migrations
npx supabase status -o env  # the local URL and keys
cp .env.example .env        # then fill it in:
#   SUPABASE_URL=http://127.0.0.1:54321 and VITE_SUPABASE_URL the same
#   SUPABASE_ANON_KEY and VITE_SUPABASE_ANON_KEY: ANON_KEY (or PUBLISHABLE_KEY) from status
#   SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY (or SECRET_KEY) from status
#   ALLOWED_ORIGINS=http://127.0.0.1:5173
#   ALLOWED_TARGET_HOSTS=127.0.0.1:4173  (a local site; http is allowed for hosts listed exactly)
#   VITE_API_URL=http://127.0.0.1:8080
npm run server:dev          # API and worker on http://127.0.0.1:8080
cd web && npm ci && npm run dev   # dashboard on http://127.0.0.1:5173
```

- The magic-link emails go to the local mail catcher, at the address `supabase status` lists
  (usually <http://127.0.0.1:54324>).
- Serve a site to test on port 4173, for example the STEM-Accessibility frontend with
  `npm run build && npm run preview` (Vite's preview port is 4173).
- `npx supabase db reset` re-creates the local database from the migrations.
- `npx supabase stop` stops the stack.

Without Docker you can still run the tests:

- `npm test` covers the server (allowlist, validation, API, worker against local fixture sites,
  with a fake Supabase client) and the dashboard (walked with this tool).
- `npm run test:sql` applies the migration to a throwaway local PostgreSQL (it needs `initdb`,
  `pg_ctl` and `psql`) on a stub of Supabase's roles, `auth` and `storage`, and checks the grants,
  policies, the per-user limit and `claim_next_run()`.

## Which sites the server will test

`ALLOWED_TARGET_HOSTS` is a comma-separated list. An empty list allows nothing.

| Rule | Allows | Does not allow |
|---|---|---|
| `stem-accessibility.example.org` | `https://` and `http://` on that host, default port | `www.stem-accessibility.example.org`, other ports |
| `*.vercel.app` | `https://` on any subdomain, e.g. `https://frontend-git-x.vercel.app` | `vercel.app` itself, `evilvercel.app`, `vercel.app.evil.com`, `http://` |
| `127.0.0.1:4173` | that address and port, `http://` or `https://` | other ports, `localhost`, other loopback addresses |

The server also refuses addresses with a user name or password, IP addresses and `localhost`
unless listed exactly, and journeys that are not files in its own `targets/` (users choose
journeys by path; the server never runs code a user sends). It checks a run again before running
it, because a signed-in user can also insert a queued run straight into the table.

`*.vercel.app` admits any Vercel deployment, including other people's. Prefer exact hosts, or a
domain only you control, where you can.

## Operations

- **Updates.** Render and Netlify deploy when the branch changes. For a schema change, add a new
  file to `supabase/migrations` and run `npx supabase db push` before deploying code that needs it.
  When you update Playwright, change the `Dockerfile`'s image tag to the same version.
- **Timeouts.** A run that takes longer than `RUN_TIMEOUT_SECONDS` is stopped, browser included;
  the journeys that finished keep their results. When Render restarts the service (a deploy, say),
  the run in progress goes back in the queue. A run left `running` by a service that crashed is
  marked failed ten minutes after its timeout.
- **Limits.** Three runs waiting or running per user (`limit_active_runs` in the migration).
- **Storage.** Reports are kept until you delete them (*Storage → reports*). Deleting a user
  deletes their runs and results, but not their report files.
- **Logs.** Render's log shows each run starting and ending; the network guard's refusals are
  stored with the run (`summary.blocked_requests`) and shown on the run page.

## Security

- **Keys.** The service role key exists only in Render's environment. The run process that drives
  the browser is started without it (and without any variable that looks like a secret). The
  dashboard has only the anon key, which row-level security makes safe to publish.
- **Network guard.** Pages under test are untrusted, and their scripts run in the server's
  Chromium. Every connection the browser makes goes through a proxy, local to the run, that
  refuses loopback, private-network, link-local (cloud metadata) and other reserved addresses
  unless the host is listed exactly in `ALLOWED_TARGET_HOSTS`. It resolves each host itself and
  connects to the address it checked, so a DNS answer that changes cannot redirect it. Requests a
  journey's own `setup` answers (the STEM-Accessibility mock) never leave the browser, so mocks
  still work. WebRTC is not covered by the proxy.
- **Chromium's sandbox** is off by default, because it cannot start inside a standard Docker
  container (Render's included). A Chromium exploit in a tested page could therefore reach the
  container, where the server's environment holds the service role key. Keep the list of allowed
  sites short and trusted, keep Playwright and the image up to date, and set
  `CHROMIUM_SANDBOX=true` only on a host where Chromium's sandbox works.
- **Reports** are downloaded through signed URLs that last an hour and are served as downloads.
- **CORS** limits which websites may call the API from a browser; it is not authentication. Every
  call that reads or creates runs needs a valid Supabase access token.
