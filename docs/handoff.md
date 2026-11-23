# Handoff

Rolling handoff for the Claude Code session relay. Each handover rewrites this file; it is
never copied to a dated file. Written 23 November 2026, 10:15 Europe/Berlin, by session
`session_015Hhm4h93DKDys7UMr5tfaw` (the relay's first session).

The work spans three repositories:

- **pisan-labs/screen-reader-journeys** (this one): a tool that walks a website by keyboard and
  records what a screen reader user would hear.
- **stem-accessibility/frontend** and **stem-accessibility/backend**: the STEM-Accessibility
  site, where the owner's pull requests are being reviewed by the maintainer (J. Mankoff,
  `jmankoff`). Some of those pull requests come from the owner's forks `pisanuw/sa-frontend` and
  `pisanuw/sa-backend`.

## What is live

- **screen-reader-journeys:** `main` holds only the README. The tool itself is in pull request
  #1, waiting for the owner.
- **stem-accessibility/frontend `main`** now includes the CI and lint fixes (#7), the contrast
  fixes (#6), slide-deck upload (#5) and the underlined 404 Home link (#17).
- Which build Vercel serves as the production site was not checked.

## Merged since the last handoff

There is no earlier handoff. These are the merges in the 24 hours before this one, all by
`jmankoff` on 22 November (Europe/Berlin):

| Time | Pull request |
|---|---|
| 22:25 | stem-accessibility/frontend#6, improve color contrast |
| 22:27 | stem-accessibility/frontend#5, slide-deck upload and results pages |
| 23:05 | stem-accessibility/frontend#17, underline the Home link on the page-not-found screen |
| 23:08 | stem-accessibility/frontend#7, add CI, sync the lockfile and make lint pass (the owner's) |

## Open pull requests and branches

The owner's (opened by Claude sessions):

| Pull request | Branch | State |
|---|---|---|
| pisan-labs/screen-reader-journeys#1, the tool's first version (draft) | `claude/vertical-slice` | CI green, waiting for the owner |
| stem-accessibility/frontend#9, braille | `pisanuw/sa-frontend` `claude/zealous-bohr-pas7fq-braille` | Review answered. No conflict; GitHub says "unstable" with no Actions runs attached, so probably a commit status such as Vercel's fork preview (not checked) |
| stem-accessibility/frontend#10, sonification description | `pisanuw/sa-frontend` `claude/zealous-bohr-pas7fq-sonification` | **Merge conflict** with `main` (GitHub: dirty) |
| stem-accessibility/frontend#11, math (stacked on #9) | `pisanuw/sa-frontend` `claude/zealous-bohr-pas7fq-math` | Mergeability still being computed by GitHub on 23 November |
| stem-accessibility/frontend#12, roadmap | `pisanuw/sa-frontend` `claude/zealous-bohr-pas7fq-roadmap` | Docs only; mergeability still being computed |
| stem-accessibility/frontend#19, pointer to the workflow doc (draft) | `stem-accessibility/frontend` `claude/vigilant-einstein-f2spjo` | Merge after backend#8 |
| stem-accessibility/backend#6, worker import and CI | `pisanuw/sa-backend` `claude/zealous-bohr-pas7fq-worker-ci` | Review fixes pushed |
| stem-accessibility/backend#7, backend roadmap | `pisanuw/sa-backend` `claude/zealous-bohr-pas7fq-roadmap` | Docs only |
| stem-accessibility/backend#8, workflow recommendations (draft) | `stem-accessibility/backend` `claude/vigilant-einstein-f2spjo` | Docs only |

Other contributors' open pull requests, which the owner's account has commented on:
stem-accessibility/frontend#13, #14, #15 and #16 (`luyichen930-sudo`), stem-accessibility/backend#5
(`Xunmei-liu`, slide decks), and the new stem-accessibility/frontend#30 (`jmankoff`, "adding
resources", not reviewed).

The `pisanuw/sa-frontend` fork also has branches with no open pull request: `…-foundations`
(merged as #7), `…-contrast` (#8, closed), `…-dead-files`, `…-unused-deps` and
`…-upload-formats`. Leave them alone unless the owner asks.

## Next, in order

1. **Bring frontend #9, #10, #11 and #12 up to date** now that #7, #6 and #5 are on `main`.
   #10 has a conflict; check the others first.
   - Merge `main` into each fork branch; never rebase or force-push.
   - Run `npm ci`, `npm run lint`, `npm test` and `npm run build` on each.
   - Push, and say on each pull request what was merged.
   - #11 is stacked on #9, so merge #9's branch into #11's after updating #9.
   - The CHANGELOG conflicts keep both sides' entries.
2. **Answer review comments** on the owner's stem-accessibility pull requests as they come in.
   The owner merges those pull requests themselves.
3. **screen-reader-journeys:**
   - Act on the owner's decisions below (Orca, licence) once answered.
   - Help with the first VoiceOver run when the owner is at a Mac.
   - Once the owner merges #1, add journeys for the tactile key download (#9), the sonification
     player (#10) and math (#11).

## Waiting on the owner

**Decisions:**

1. **Real Orca on Linux.** Guidepup 0.40 can drive the Orca screen reader on Linux, which would
   give every pull request a real screen-reader transcript in free CI. Its setup
   (`npx @guidepup/setup`) downloads and installs Guidepup's Orca bundle from GitHub. This
   session's safety check blocked it, so it needs the owner's explicit approval.
   - Options: (a) approve trying it; (b) not now.
   - Recommendation: (a).
   - With no answer: nothing happens. This is an install, so no default is taken.
2. **Licence for screen-reader-journeys.**
   - Options: (a) MIT, the same as Guidepup; (b) Apache-2.0; (c) keep it unlicensed for now.
   - Recommendation: (a).
   - With no answer: no licence is added, since publishing terms are the owner's call.

**Actions:**

- Merge pisan-labs/screen-reader-journeys#1 when satisfied. CI is green.
- In pisan-labs/screen-reader-journeys, Settings → General, turn on "Automatically delete head
  branches".
- VoiceOver: on halflife or the laptop, follow `docs/voiceover.md` from #1, then run:
  ```bash
  node src/cli.js run targets/stem-accessibility --base-url https://frontend-git-claude-vigilant-einstein-f2spjo-stem-accessibility.vercel.app --mode voiceover
  ```
  A working run prints one line per journey, for example
  `Shared STEM image: Tab through the Summary view [voiceover] … pass, 6 errors, 2 warnings`,
  and writes `reports/summary.md`. This has never run on a Mac, so expect to adjust it.

## Dated tasks

None.

## Notes

- **Shallow single-branch clones:** a branch pushed from one has no remote-tracking ref, so the
  Stop hook reports "unpushed commits" falsely. Fix:
  ```bash
  git config --add remote.origin.fetch "+refs/heads/BRANCH:refs/remotes/origin/BRANCH"
  ```
  then run `git fetch` and `git branch -u origin/BRANCH`.
- **Playwright** 1.63.0 is preinstalled in cloud sessions, with its browsers in `/opt/pw-browsers`.
  screen-reader-journeys pins the same version.
- **The emulator's bug:** Guidepup's Virtual Screen Reader throws `a.getElementById is not a
  function` when a page swaps views. Reports list it under "Tool errors". Reporting it upstream
  would be publishing, so ask first.
- **Testing STEM-Accessibility builds:** the shared page `/p/srj-demo` is faked in the browser by
  `targets/stem-accessibility/mock.js`, and Vercel previews of branches in
  `stem-accessibility/frontend` open without a login. Previews of fork pull requests wait for a
  team member to authorize them.
- The owner reviewed the other contributors' pull requests through this session. The maintainer
  asked on frontend#10 whether changes were checked with a real screen reader. The owner
  answered, and said there should be **no further reply** there.

## Notes for the next session

### Standing instructions from the owner

- **Do not merge** stem-accessibility pull requests; the owner merges them by hand. Merging this
  repository's handoff pull requests is allowed (the merge rule below).
- Make changes on the owner's own pull request branches (the table above). Never push to other
  contributors' branches; review them by comment only.
- Comment on GitHub only where needed. A comment reads as the owner's own, so end each one with
  the Claude Code footer.
- No reply on stem-accessibility/frontend#10.
- The owner stopped the check-ins on backend#8 and frontend#19. GitHub events still wake the
  session, so subscribe to the open pull requests again after taking over.
- Number the questions and give a recommendation. With no answer in 15 minutes, take the
  recommendation and say how to undo it, except for anything on the owner's explicit-yes list
  (production data, money, deploys, deleting, secrets, rewriting shared history, publishing
  outside the session, and installing third-party software such as the Orca bundle).

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
| Report delivery | `SendUserFile` for reports and cards. This session had no `SendUserMessage`, so the line "HH:MM Nothing to report." is the whole reply text |

These were proposals, taken as defaults when the owner did not answer within 15 minutes on 23
November. The owner can change any of them; update this table and the scheduled tasks.

### Scheduling

- **This session:** `session_015Hhm4h93DKDys7UMr5tfaw`, started 20 November 2026, lineage depth
  0 of 8. It was at 54% of its context when the relay was set up.
- **Previous session:** none (this is the first).
- **Scheduled tasks**, all aimed at this session:

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
