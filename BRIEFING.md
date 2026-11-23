# Briefing

## Scope

- **The tool:** walks a website by keyboard and records what a screen reader user would hear.
  It has five modes (`walker`, `virtual`, and real `voiceover`, `orca` and `nvda`) and six
  report formats, plus a comparison across modes and sites. It runs from the command line and
  from GitHub Actions.
- **The hosted service:** a dashboard, an API and a worker that runs journeys for signed-in
  people. It is becoming a HintWise app at `https://screen-reader-journeys.hintwise.org`
  (option B, its own repository).
- **The STEM-Accessibility journeys** in `targets/stem-accessibility/`, for the owner's pull
  requests in stem-accessibility/frontend and backend.

## Decisions

- **23 Nov 2026, owner:**
  - Make this a HintWise app, following PManager's instructions of that day (claude-built-apps
    `docs/new-app-guide.md`, option B).
  - This session is a working session outside the roles (hintwise-workflow CHARTER.md). It
    writes code on branches and opens pull requests. It does not merge or deploy: PManager runs
    a fresh Reviewer and releases.
  - No top-tier model for any subagent in this project.
  - Times for the owner are in Barcelona time (Europe/Madrid), labelled, until 6 January 2027.
- **23 Nov 2026, owner:** the worker runs in a Render service of its own, on the free plan;
  PManager generates `WORKER_TOKEN` and pins its hash at release; TypeScript for the dashboard,
  `tsc --checkJs` for the server and the CLI.
- **Proposed, not yet confirmed by the owner:** retention of each person's 20 latest runs, and
  deletion of finished runs after 30 days; per run, at most 200 report files and 20 MiB.
- **23 Nov 2026:** the MIT licence (owner's choice).

## Non-goals

- Deploying, creating accounts, or choosing paid plans. Each of those is the owner's yes, then
  PManager's step.
- Merging stem-accessibility pull requests. The owner merges them.
- Rewriting the command-line tool in TypeScript (proposed; see `docs/hintwise-gap-report.md`).
