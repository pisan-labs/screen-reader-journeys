# HintWise gap report

Written 23 November 2026, 18:10 Barcelona time (Europe/Madrid), by the session "SR-journeys"
(`session_01JyJzMV27a4zzcGw3w9f5yh`), against `main` at `3e7d890`. The standard it is measured
against is claude-built-apps `docs/new-app-guide.md` and `docs/platform.md` at `5aed40c`, option B
(an app in its own repository), section 10's checklist, and the points in PManager's
instructions of 23 November.

## Summary

- **Nothing is deployed.** No Supabase project, Netlify site or Render service exists for this
  repository. The migration on `main` has never been applied anywhere, so it can be replaced
  rather than migrated.
- **Three conflicts**, all in the hosted service that #8 added:
  1. its own sign-in (an email link through `signInWithOtp`);
  2. its tables in `public`, with its own bucket;
  3. a service-role key in the Render worker.
- **Everything else is additive:** the footer, favicon, analytics, privacy note, TypeScript,
  lint, typecheck, coverage, records and links.
- **Scope, as I read it:** the standard applies to the hosted app, which is the dashboard
  (`web/`), the API and worker (`server/`) and the migration (`supabase/`). The command-line
  tool (`src/`, `targets/`) and its GitHub workflows (evaluate, Orca, NVDA, VoiceOver, compare)
  are a developer tool that never runs on hintwise.org, so I would leave them as they are.
  PManager, please confirm.

## Section 10's checklist

| # | Item | Today | Gap |
|---|---|---|---|
| 1 | The slug, the repo name and `<slug>.hintwise.org` match | The repository is `screen-reader-journeys`. The address will be `screen-reader-journeys.hintwise.org`, label `screen-reader-journeys` | None for the names. The links are item 8 |
| 2 | Sign-in from the template, the code box, "Delete my account" | `web/src/app.js:174` calls `signInWithOtp` with an email link. The guide forbids that, because the email hook refuses it for hintwise.org pages. There is no Google sign-in, no code box and no "Delete my account" | **Conflict.** Replace it with the template's `supabase.ts`, `auth.ts`, `account.ts`, `signin-styles.ts` and `google-g-light.svg` (with their tests), and `mountSignIn` in the top bar |
| 3 | The label is on the sign-in allow-list | Not there | PManager adds `screen-reader-journeys` to `EXTERNAL_APP_LABELS` and redeploys sign-in-link and delete-account (owner's yes) |
| 4 | The migration passes `check-schema` | `supabase/migrations/20261123120000_runs.sql` creates `public.runs` and `public.run_results` and a bucket named `reports`. The owner column is `created_by`, not `user_id`. `run_results` has no user column. The file name is not `NNNN_<name>.sql` | **Conflict.** A new `0001_runs.sql` in schema `app_screen_reader_journeys`, with `user_id` on every table, row level security, grants to `authenticated` and nothing for `anon`. It needs no `llm_apps` row, since the app makes no model calls |
| 5 | No Anthropic key and no service-role key | There is no Anthropic key anywhere. The service-role key is in `server/config.js:55`, `server/index.js:41`, `render.yaml` and `.env.example`: the worker claims runs, writes results and uploads reports with it | **Conflict.** Proposed fix below |
| 6 | The footer once, a favicon, no sideways scroll at 375 px | The dashboard has its own `<footer class="site-footer">` (`web/src/index.html:32`) and an empty favicon (`data:,`). `body` is a column flexbox, which the guide allows. 375 px has not been measured | Embed `footerHtml('screen-reader-journeys')` before `</body>`, with a sha256 test and `grep -c data-site-footer` = 1. Add the tag from `platform/brand/favicon-link.html`. Add a Playwright check at 375 px |
| 7 | The owner imports the repository in Netlify, and the domain is attached | `netlify.toml` exists (base `web`, publish `dist`), but no site does | The owner imports it with Deploy Previews and branch deploys off. Then PManager runs "Attach custom domain" |
| 8 | The app links only `https://screen-reader-journeys.hintwise.org` | `render.yaml:27` names `screen-reader-journeys.netlify.app`. `.env.example:39` and `web/build.mjs:7` name `screen-reader-journeys.onrender.com` | Replace them with the hintwise.org address. Name the API by its own address only where the code must |

## PManager's other points

- **Analytics:** there are none today.
  - Add `hw-events.js` byte for byte. Its sha256 `d2833162…0633` matches claude-built-apps
    `5aed40c`.
  - Put `<script defer src="/hw-events.js" data-app="screen-reader-journeys">` once in `<head>`,
    with a test that pins the sha256.
  - No `data-mask` is needed. Run ids live in the hash (`#/runs/<id>`), and `hw-events.js` sends
    only the pathname.
  - Add a privacy note that visitors can see. It says that visits are counted without cookies,
    and what the service stores (below).
- **CSP:** `web/build.mjs` writes `_headers`. `connect-src` must allow `https://auth.hintwise.org`,
  and `style-src` must list `FOOTER_STYLE_CSP`.
- **Model calls:** none. **Email:** none beyond sign-in.
- **Data and deletion:** a run holds the site address tested, the journeys, the modes, the
  status and the results, plus the Markdown reports. Account deletion
  (`platform.delete_hintwise_data`) covers every column in an `app_%` schema that has a foreign
  key to `auth.users`, so the new schema is covered. The README will say what is stored (Supabase,
  US East) and how to delete the account.
- **Render:**
  - The worker starts Chromium, and the emulated screen reader, for every run. Each browser runs
    as a separate unprivileged user, behind an egress proxy that limits which hosts it can reach.
  - The guide's default for a long-running server is a path prefix in `backend-hub`: one shared
    instance with 0.5 CPU and 512 MB. Chromium on a real page can use most of that, and a browser
    sandbox does not belong in a process other apps share. So this app needs a Render service of
    its own. That is the owner's call (question 1 below).
  - `render.yaml` today uses the free plan in Frankfurt. The shared Supabase project is in
    us-east-1, so the service should move to Render's Virginia region.
- **Conventions:**
  - **TypeScript:** none. All the code is JavaScript: about 25 files in `src/`, `server/` and
    `web/`, plus the tests. See question 2.
  - **Tests:** all 210 tests (`node:test`) pass.
    - Coverage of the non-test files, measured with `node --test --experimental-test-coverage`:
      84.2% of lines, 84.7% of branches and 80.7% of functions. All three are under 85%.
    - `web/src/app.js` runs in the browser and is not counted.
  - **Lint and typecheck:** none. **Build:** `web/build.mjs` (esbuild).
  - **`.env.example`:** present. It will be rewritten without the service-role key.
  - **Conventional Commits:** not used so far (subjects like "Add the MIT licence (#3)"). They
    are used from this commit on.
  - **Records:** `BRIEFING.md` and an append-only `CHANGES.md` are added with this report.
  - **`[skip netlify]`:** in docs-only commits from now on.
  - **Times:** Barcelona time (Europe/Madrid), labelled, until 6 January 2027.

## The proposed fix for the service-role key

This follows Delivery Canary's pattern, where a job proves itself to a few security-definer
functions with a token whose hash is pinned in the database. Everything else stays behind row
level security.

- **The token:**
  - The worker holds a random token, `WORKER_TOKEN`, as a Render secret, and the database holds
    only its sha256.
  - The owner makes the token with `openssl rand -base64 32` and gives PManager only its sha256.
  - PManager pins the hash with a small ops SQL file after the owner's yes, the way `anon-setup`
    works.
- **The functions** in `app_screen_reader_journeys`. Each checks the token's hash first, with a
  fixed `search_path`:
  - `worker_claim_next_run(token)`: the oldest queued run (`for update skip locked`);
  - `worker_add_result(token, run_id, …)`;
  - `worker_save_report(token, run_id, path, body)`;
  - `worker_finish_run(token, run_id, status, error, summary)`.
- **The reports** move from a Storage bucket to a table (`run_reports`, at most 1 MB per report),
  because an upload to Storage needs a privileged key. People read their own reports through
  row level security.
- **The API** keeps acting with the person's own token for everything else. It already does
  (`server/index.js:43`).
- **The cost:** the worker has the four functions' power and nothing else. Anyone with the token
  can claim, fill in or finish any run, but cannot read other people's runs.
- **A question for PManager:** does `check-schema` accept tables that people may only read and
  insert into? Users get no update or delete policy here, because only the worker functions
  change runs.

## The plan: pull requests

1. **Data and worker without the service-role key:**
   - the new migration and the worker functions;
   - the server changes;
   - the SQL tests;
   - removing the old `public` migration, which was never applied.
2. **The dashboard on the platform:**
   - Vite and TypeScript from the template;
   - the template's sign-in and "Delete my account";
   - the footer with its sha256 test, and the favicon;
   - `hw-events.js` with its test, and the privacy note;
   - the CSP;
   - a Playwright walkthrough against `vite preview` with fakes, including 375 px.
3. **Gates and docs:**
   - ESLint, the typecheck, and coverage of at least 85% in CI;
   - the README's user section (what it does and for whom, what is stored, how to delete the
     account, one honest limitation);
   - `docs/deploy.md` rewritten for HintWise;
   - `render.yaml` (region, no service-role key);
   - links to the hintwise.org address only.

Pull requests 1 and 2 together are the vertical slice: sign in, queue a run, the worker runs it,
and the results show.

Then I send "ready for Netlify and the domain", with the migration's commit and sha256 and the
sign-in label `screen-reader-journeys`.

## Open questions (asked of the owner in the session)

1. **Render:** a service of its own for the worker. Should it be the free plan to start (it sleeps
   after 15 idle minutes, with 512 MB) or a paid plan? A paid plan needs the owner's yes.
2. **TypeScript scope:** TypeScript for the dashboard, which is being rewritten anyway. The
   server and the CLI stay JavaScript, checked by `tsc --checkJs` with JSDoc types and linted,
   rather than rewritten.
