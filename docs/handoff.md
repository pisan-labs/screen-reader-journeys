# Handoff

Rolling handoff for the Claude Code session relay. Each handover rewrites this file; it is never
copied to a dated file. Written 23 November 2026, 15:16 Europe/Berlin, by session
`session_015Hhm4h93DKDys7UMr5tfaw`, for a session the owner starts by hand.

The work spans three repositories:

- **pisan-labs/screen-reader-journeys** (this one): a tool that walks a website by keyboard and
  records what a screen reader user would hear. It has five modes: `walker`, `virtual`
  (emulated), and real `voiceover`, `orca` and `nvda`.
- **stem-accessibility/frontend** and **stem-accessibility/backend**: the STEM-Accessibility
  site. The maintainer (J. Mankoff, `jmankoff`) reviews and merges pull requests there. The
  owner's pull requests come from the owner's forks `pisanuw/sa-frontend` and
  `pisanuw/sa-backend`.

## What is live

- **screen-reader-journeys `main`** is at `152d5f0`. It has:
  - the tool, with all five modes;
  - six report formats: Markdown, JSON, HTML, JUnit, SARIF and CSV;
  - the comparison report across modes and sites (`compare.md`, `compare.html`, `srj compare`);
  - journeys for frontend #9, #10 and #11;
  - the MIT licence;
  - workflows:
    - **CI:** tests on every pull request.
    - **Evaluate a site:** walker and virtual, by hand or called from another repository.
    - **Orca:** on GitHub's `ubuntu-26.04` runner.
    - **NVDA:** on `windows-latest`.
    - **VoiceOver:** a self-hosted Mac. It has never run.
    - **Compare screen readers:** by hand. It runs the walker, the emulated screen reader, Orca
      and NVDA, then compares them. It has not run yet.
- **Nothing is deployed.** The hosted version (#8) is not merged, and no Supabase, Render or
  Netlify account or project exists for it.
- **stem-accessibility/frontend `main`** has had no merges since 22 November.

## Merged since the last handoff

The last handoff merged on 23 November at 10:11 Europe/Berlin (#2). Since then, in
pisan-labs/screen-reader-journeys, merged by this session after CI passed (GitHub shows them as
merged by `pisanuw`, the owner's account the session uses). #1 landed as a merge commit; the
rest were squash-merged.

| Time (Berlin) | Pull request |
|---|---|
| 11:30 | #1, the tool's first version (owner's go-ahead) |
| 11:36 | #3, the MIT licence (owner's choice) |
| 11:44 | #5, HTML, JUnit, SARIF and CSV report formats |
| 11:57 | #4, the `orca` and `nvda` modes: real Orca and NVDA on GitHub's runners |
| 15:14 | #6, the comparison report and the *Compare screen readers* workflow |
| 15:14 | #7, journeys for frontend #9 (tactile key), #10 (sonification) and #11 (math) |

Nothing merged in stem-accessibility since 22 November.

## Open pull requests and branches

**pisan-labs/screen-reader-journeys.** #6, #7 and #8 were opened as drafts at 15:08–15:09 on 23
November. The owner said "Yes push", and the question asked was to push these three branches,
open pull requests and merge each once CI passes. #6 and #7 are merged. That leaves one:

| Pull request | Branch | What | State and plan |
|---|---|---|---|
| #8 (draft) | `claude/deploy-architecture` | The hosted version: Supabase schema and RLS, Render API and worker in Docker with a network guard, Netlify dashboard, `docs/deploy.md`; security-review fixes in `e51907f` | `main` merged in as `832e398` (15:15); `npm test` (210) and `npm run test:sql` passed locally. CI (`test`, `orca`, `nvda`) was running at 15:16. When it passes: mark it ready for review, then squash-merge |

In #8, Chromium's sandbox is off, because it cannot start in Docker. `render.yaml` uses Render's
free plan; upgrading it is the owner's call.

**stem-accessibility, the owner's** (opened by Claude sessions). The owner merges these; never
merge them yourself.

| Pull request | Branch (repository) | State on 23 November |
|---|---|---|
| frontend#9, braille (.brf, tactile graphic, Braille view) | `claude/zealous-bohr-pas7fq-braille` (`pisanuw/sa-frontend`), head `1ba543f` | Review answered; merged cleanly with `main` in the morning |
| frontend#10, sonification description | `claude/zealous-bohr-pas7fq-sonification` (`pisanuw/sa-frontend`), head `6cb0474` | The conflict was resolved by merging `main` in. Lint passed with 0 errors, 151 tests passed, the build worked |
| frontend#11, math (stacked on #9) | `claude/zealous-bohr-pas7fq-math` (`pisanuw/sa-frontend`), head `a22373d` | Merged cleanly in the morning |
| frontend#12, roadmap | `claude/zealous-bohr-pas7fq-roadmap` (`pisanuw/sa-frontend`), head `e6333f9` | Docs only |
| frontend#19, pointer to the workflow doc (draft) | `claude/vigilant-einstein-f2spjo` (`stem-accessibility/frontend`) | Merge after backend#8 |
| backend#6, worker import and CI | `claude/zealous-bohr-pas7fq-worker-ci` (`pisanuw/sa-backend`) | Review fixes pushed |
| backend#7, backend roadmap | `claude/zealous-bohr-pas7fq-roadmap` (`pisanuw/sa-backend`) | Docs only |
| backend#8, workflow recommendations (draft) | `claude/vigilant-einstein-f2spjo` (`stem-accessibility/backend`) | Docs only |

Mergeability was not rechecked after the morning of 23 November.

**Other contributors' open pull requests**, which the owner's account has commented on:

- **luyichen930-sudo:** frontend#13 (home page example links), #14 (loading and retry states),
  #15 (page titles) and #16 (hidden flowchart viewer out of the Tab order).
- **jmankoff:** frontend#30, "adding resources". Not reviewed.
- **Xunmei-liu:** backend#5 (PDF slide decks).

The `pisanuw/sa-frontend` fork also has branches with no open pull request: `…-foundations`
(merged as #7), `…-contrast` (#8, closed), `…-dead-files`, `…-unused-deps` and
`…-upload-formats`, and the bare `claude/zealous-bohr-pas7fq` (`863fe07`). Leave them alone
unless the owner asks.

## Next, in order

1. **Land #8** in pisan-labs/screen-reader-journeys, as planned in the table above. Check its
   state first: the previous session was merging it when CI passed.
   - A draft must be marked ready (`update_pull_request` with `draft: false`) before it can merge.
   - On a CI failure, find the root cause and fix it on the branch. Never skip or disable a test.
   - Subscribe to it (`subscribe_pr_activity`). If that says another session is watching, the
     previous session still holds it until it is archived.
2. **Run the *Compare screen readers* workflow** once by hand (it is on `main` since #6), to check it
   works on GitHub:
   - Use `mcp__github__actions_run_trigger` with `run_workflow`, workflow `compare.yml`, ref
     `main`.
   - Inputs: `base_url` set to a Vercel preview of the frontend, and `journeys` set to
     `targets/stem-accessibility`.
   - Branch previews in `stem-accessibility/frontend` open without a login. The previous session
     tested against `https://frontend-git-claude-vigilant-einstein-f2spjo-stem-accessibility.vercel.app`.
3. **Act on the owner's answer** to decision 1 below (the #10 and #11 findings).
4. **Answer review comments** on the owner's stem-accessibility pull requests as they come in.
5. **VoiceOver:** help with the first run when the owner is at a Mac (owner actions, below).
6. **Deployment:** only when the owner asks. Deploying, creating accounts and choosing paid plans
   are all the owner's to approve.

## Waiting on the owner

**Decisions:**

1. **Accessibility findings in the owner's frontend #10 and #11.** The new journeys in #7 found:
   - **#10 (sonification):**
     - If the browser's speech fails, the player stays at "Playing…" with the button
       unavailable, and X cannot recover it without a reload. This was seen in headless
       Chromium, which has no voices; how often it happens in real browsers is unknown.
     - X is the only stop key, and NVDA and JAWS use X themselves in browse mode (next
       checkbox), so the page may never get it.
     - The "Press X to stop" hint comes after the button and is not linked to it, so Tab users
       hear only "Play sonification, button".
     - Stopping is not announced in text; only the player's own voice says "Stopped."
     - The description says a voice "reads the title", but the player reads the file name and
       the raw column names.
   - **#11 (math):**
     - Every formula, even a single letter, is a Tab stop: 8 extra stops on the test page.
     - Screen readers get MathJax's spoken text, not MathML.

   The options:
   - (a) Fix them on the owner's fork branches.
   - (b) Post them as comments on the pull requests.
   - (c) Leave them to the owner.

   - Recommendation: (a) for #10's stuck player and the unlinked hint; (c) for the rest.
   - With no answer: nothing happens, since (a) and (b) both publish.
2. **Pushing to screen-reader-journeys from now on.** The owner's "Yes push" (23 November) was an
   answer to a question about these three branches. Whether it covers future pushes was not
   stated.
   - Options: (a) treat it as standing for this repository; (b) ask before each push.
   - Recommendation: ask once, in the takeover report.
   - With no answer: (b).

**Actions** (only the owner can do these):

- **VoiceOver:** on halflife or the laptop, follow `docs/voiceover.md`, then run:
  ```bash
  node src/cli.js run targets/stem-accessibility --base-url https://frontend-git-claude-vigilant-einstein-f2spjo-stem-accessibility.vercel.app --mode voiceover
  ```
  A working run prints one line per journey and writes `reports/summary.md`. It has never run on
  a Mac, so expect to adjust it.
- **The time zone:** confirm Europe/Berlin, or give the right one. It was inferred, never
  confirmed.

## Dated tasks

None.

## Notes

- **Safety check on pushes:** on 23 November the auto-mode safety check refused a
  `git push` to this public repository ("sensitive information leakage") and, for a while, local
  commits. Nothing secret was in them. It allowed them after the owner said "Yes push". Do not
  work around a refusal (for example, by pushing through the GitHub API); ask the owner.
- **Worktrees:** while background agents use a repository, keep the primary checkout on `main`
  and work in `git worktree`s. Do not switch branches there; the owner's rules ask for this.
- **Fetch refspecs:** a single-branch clone needs one refspec per branch. A refspec for a branch
  that has since been deleted (this repository deletes merged branches) breaks `git fetch` with
  "couldn't find remote ref". Remove it with:
  ```bash
  git config --unset remote.origin.fetch '^\+refs/heads/<branch>:'
  ```
- **Playwright** 1.63.0 is preinstalled in cloud sessions, with its browsers in
  `/opt/pw-browsers`. This repository pins the same version.
- **#8 locally:**
  - Run `npm ci` at the root; `@supabase/supabase-js` is a root dependency, and the dashboard
    build resolves it from there.
  - `npm run test:sql` needs `psql` and a local PostgreSQL.
  - Building the Docker image inside this sandbox fails at `npm ci` (`SELF_SIGNED_CERT_IN_CHAIN`,
    from the sandbox's proxy). It was checked by adding the new layers to an image built
    earlier, not by a clean build.
- **Orca on GitHub:** run `@guidepup/setup@0.29.3 setup --ci`, then `install orca`; run
  everything under `xvfb-run -a dbus-run-session --`. Orca must start before the browser.
  Guidepup 0.40 groups the Orca command names, for example `WhereAmIPresenter.PresentTitle`.
- **The emulator's bug:** Guidepup's Virtual Screen Reader throws `a.getElementById is not a
  function` when a page swaps views. Reports list it under "Tool errors". Reporting it upstream
  would be publishing, so ask first.
- **Testing STEM-Accessibility builds:**
  - `targets/stem-accessibility/mock.js` fakes the backend in the browser for the shared image,
    chart and math fixtures, and gives the page a stand-in speech engine (headless browsers have
    none).
  - For a local build, use a worktree of `pisanuw/sa-frontend` with dummy `VITE_*` values, and
    run `npx vite`.
  - Vercel previews of fork pull requests wait for a team member to authorize them.
- **frontend#10:** the maintainer asked whether changes were checked with a real screen reader.
  The owner answered, and said there should be **no further reply** there.

## Notes for the next session

### Standing instructions from the owner

- **The owner's standing loop instruction (23 November):** "Keep working until further notice.
  Make all the decisions necessary. If one version is implemented, implement additional screen
  reader options, have multiple report formats. Get this repo ready to be deployed on
  netlify/render/supabase architecture."
  - Both parts are done once #8 merges: there are five modes, six formats plus the comparison
    (merged in #6), and a deployable set-up. "Ready to deploy" stops short of deploying.
- **Do not merge** stem-accessibility pull requests; the owner merges them by hand. In this
  repository, merging is allowed for the handoff pull requests (the merge rule below) and for
  work the owner has approved.
- **Branches:** make changes on the owner's own pull request branches (the table above). Never
  push to other contributors' branches; review them by comment only.
- **Comments:** comment on GitHub only where needed. A comment reads as the owner's own, so end
  each one with the Claude Code footer. No reply on stem-accessibility/frontend#10.
- **Questions:** number them and give a recommendation. With no answer in 15 minutes, take the
  recommendation and say how to undo it.
- **The owner's explicit yes is needed for:**
  - production data;
  - spending money, including paid services and API keys;
  - deploys;
  - deleting what cannot be restored;
  - secrets;
  - rewriting shared history;
  - publishing outside the session, which covers pushing to a public repository unless approved;
  - installing third-party software.
- **Tools and commits:**
  - Use the `claude` CLI, never an Anthropic API key.
  - Use `gh` only for search; use the GitHub MCP tools for everything else.
  - Put no model identifiers (such as `claude-opus-5-5`) in commits or pull requests. The
    exception is the attribution trailer the harness asks for: commits end with
    `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and a `Claude-Session:` line.
    The owner has not said whether that trailer counts; ask if it matters.
  - Keep the owner's email and personal details out of everything published.
- **CHANGES.md:** the owner's global instructions ask for one, appended in each repository. This
  repository does not have one yet.

### Parameters

| Parameter | Value |
|---|---|
| Repository | `pisan-labs/screen-reader-journeys` |
| Handoff document | `docs/handoff.md` |
| Routine time zone | `Europe/Berlin` |
| Report time zone | `Europe/Berlin` |
| Status check | every two hours at :46 (UTC cron `46 */2 * * *`) |
| Handover check | 13:56 Europe/Berlin |
| Session start | 14:52 Europe/Berlin |
| Handoff PR title | `docs: the handoff of <D Month>`, e.g. `docs: the handoff of 23 November` |
| Merge rule | Squash-merge the handoff PR once its checks pass, or at once if none run on it |
| Report delivery | `SendUserFile` for reports and cards. There was no `SendUserMessage`, so the line "HH:MM Nothing to report." is the whole reply text |

These were proposals, taken as defaults when the owner did not answer within 15 minutes on 23
November. The owner can change any of them; update this table and the scheduled tasks.

### Scheduling

- **This handoff is manual.** The owner asked for it on 23 November and will start the next
  session by hand. Today's session-start task had already run, and it starts a session only when
  a handoff pull request with that day's title exists, so it will not start one too.
- **Previous session:** `session_015Hhm4h93DKDys7UMr5tfaw`, started 20 November 2026, lineage
  depth 0 of 8. It was at 32% of its context at 13:56 on 23 November. The next session is depth
  1 of 8.
- **Scheduled tasks**, all still aimed at the previous session when this was written:

  | Id | Name | Schedule |
  |---|---|---|
  | `trig_01R7tTugjfiB2sR3kTPVapU3` | Relay: status check (every 2 h) | `46 */2 * * *` (UTC) |
  | `trig_01B2EYsDnoA63sLHZBNJgXW9` | Relay: handover check (13:56 Berlin) | `CRON_TZ=Europe/Berlin 56 13 * * *` |
  | `trig_01Ecs9X38eez5oc8y9ah74vX` | Relay: session start (14:52 Berlin) | `CRON_TZ=Europe/Berlin 52 14 * * *` |

### Takeover prompt

The session-start task passes this to `create_session`, with `<D Month>` and `<previous session
id>` filled in. For a session started by hand, paste it as the first message.

> You are taking over the session relay for pisan-labs/screen-reader-journeys and the related
> stem-accessibility work, on <D Month>. The previous session is <previous session id>.
>
> 1. Read CLAUDE.md if there is one, then docs/handoff.md on main of
>    pisan-labs/screen-reader-journeys. If it is not today's, read it from the open pull request
>    titled "docs: the handoff of <D Month>". Use the session-relay skill if it is available.
> 2. Move every scheduled task whose persistent_session_id is the previous session to yourself.
>    Run list_triggers, paging until has_more is false. For each such task, create the same task
>    (same name, prompt and schedule, initiation human_schedule) aimed at yourself, then delete the
>    old one. Keep a paused task paused. For a one-shot task due within ten minutes, delete the old
>    one first. If a delete is refused, disable the old task and say so. Leave every other task
>    alone, and name any relay-looking task aimed at an older session in your report.
> 3. Only after that, run list_triggers again and confirm no task still targets the previous
>    session. Then call get_session with the previous session's id. If its status_bucket is
>    "working", try again at your next status check; otherwise call archive_session on it. If
>    archiving is unavailable or refused, ask the owner to archive it from its ⋯ menu.
> 4. Attach the repositories docs/handoff.md lists with add_repo, as the work needs them, and
>    subscribe again (subscribe_pr_activity) to the owner's open pull requests listed there.
> 5. Send a status report now with SendUserFile, saying you took over, with your session id and
>    whether the previous session was archived.
> 6. Work the handoff's "Next, in order", under its standing instructions.
