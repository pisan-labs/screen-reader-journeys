# screen-reader-journeys

Walk a website the way a keyboard and screen reader user does, and write down what they would
hear at every step.

A **journey** is a short script of what a user does, such as "open a shared STEM image, choose
the Braille view, download the file, hear that it downloaded". The tool runs it with the real
browser keyboard and writes a transcript: each key press and what a screen reader would say
after it. It also flags common problems: focus with no name, focus inside `aria-hidden`, no
visible focus indicator, keyboard traps, and announcements that never come.

The transcripts are meant to be read by a person reviewing a change. **This does not replace
testing with a real screen reader, or with people who use one.** It gives reviewers evidence to
start from and catches regressions between those tests.

## Modes

| Mode | What you get | Runs on |
|---|---|---|
| `walker` | Each Tab stop's role, name and states from Chromium's accessibility tree (the data screen readers receive), plus live-region announcements. | Anywhere, including Linux CI |
| `virtual` | An emulated screen reader ([Guidepup Virtual Screen Reader](https://github.com/guidepup/virtual-screen-reader)) inside the page: its speech for each step, and line-by-line reading. | Anywhere, including Linux CI |
| `voiceover` | Real VoiceOver's speech, through [Guidepup](https://github.com/guidepup/guidepup). Not yet tried on a Mac; see [docs/voiceover.md](docs/voiceover.md). | A logged-in Mac |
| `orca` | Real Orca (the Linux screen reader) through Guidepup, with Chromium. Needs Guidepup's setup, which supports Ubuntu 26.04 or later; the **Orca** workflow runs it on GitHub's Ubuntu 26.04 runners. | Ubuntu 26.04+, e.g. GitHub Actions |
| `nvda` | Real NVDA (the most used Windows screen reader) through Guidepup, with Chromium. The **NVDA** workflow runs it on GitHub's Windows runners. | Windows, e.g. GitHub Actions |

Screen readers differ from each other and from these modes, so treat a transcript as "what this
mode heard", not as what every user hears.

## Quick start

Needs Node.js 20.10 or later.

```bash
npm ci
```
```bash
npx playwright install chromium
```
```bash
node src/cli.js run targets/stem-accessibility --base-url https://frontend-git-<branch>-stem-accessibility.vercel.app
```

The reports go to `reports/`. Each journey and mode gets a report with the checks, the findings
and the transcript. The exit code is 1 if a journey failed.

```
srj run [paths...] --base-url URL [--mode walker,virtual] [--format md,json,html] [--out reports] [--headed] [--fail-on error|warning|none]
srj list [paths...]
srj compare [reports...] [--out compare] [--format md,html,json]
```

## Report formats

Choose with `--format` (comma-separated; the default is `md,json,html`):

| Format | Files | For |
|---|---|---|
| `md` | `<journey>.<mode>.md`, `summary.md` | Reading in a pull request or on GitHub |
| `json` | `<journey>.<mode>.json` | Other tools; the complete result |
| `html` | `<journey>.<mode>.html`, `summary.html` | Reading in a browser. Self-contained, accessible (no axe violations, light and dark) |
| `junit` | `junit.xml` | CI test reports (GitHub, GitLab, Jenkins). Each check is a test case; error findings fail |
| `sarif` | `results.sarif` | SARIF 2.1.0 viewers. Results point at the page URL, since a rendered page has no source file |
| `csv` | `findings.csv`, `checks.csv` | Spreadsheets. Cells that would start a formula are prefixed with `'` |

Page text is untrusted, so every format escapes it.

## Comparing modes and sites

When a journey runs in more than one mode, `srj run` also writes `compare.md` and `compare.html`:
one table per journey, with a column per mode and a row per step, showing what each one heard.
Each row lists its differences:

- **silent in …**: a screen reader said nothing after Tab or Shift+Tab. Sometimes that is right
  (focus went into `aria-hidden`); often it is a missing name or role.
- **focus differs**: the runs were on different elements after the same step.
- **missing in …**: a run has no such step, for example because it stopped early.

`srj compare` does the same for runs made separately: on different machines (Orca on Linux, NVDA
on Windows) or against two sites, such as `main` and a pull request's preview. Give it the
report folders; it reads the JSON results, and links each column to that run's own report.

```bash
node src/cli.js compare reports-main reports-preview --out compare
```

See [an example](docs/examples/compare.walker-virtual.fixture.md).

Paths are `*.journey.js` files, or folders to search; the default is `targets/`. `--fail-on
error` also fails the run when a finding is an error, not only when a journey's checks fail.

## Writing a journey

```js
// targets/<site>/journeys/<name>.journey.js
export default {
  name: "Shared STEM image: download the braille file",
  start: "/p/srj-demo",            // path on the site under test
  ready: "h1",                     // optional: wait for this before starting
  setup: (page) => mockBackend(page), // optional: Playwright page set-up, e.g. faking API calls
  async run(sr) {
    await sr.tabTo({ role: "combobox", name: /choose a representation/i });
    await sr.selectOption("Braille (.brf)");
    await sr.tabTo({ role: "button", name: /download braille file/i });
    await sr.activate({ expectDownload: /\.brf$/ });
    await sr.expectAnnouncement(/downloaded/i);
  },
};
```

Find elements by **role and accessible name**, the way screen reader users do, not by CSS
selectors. That way a journey keeps working when the markup changes, and fails when what users
hear changes.

| Command | Does |
|---|---|
| `sr.tab(n)`, `sr.shiftTab(n)` | Press Tab or Shift+Tab |
| `sr.tabTo({ role, name }, { max })` | Tab until focus is on that element; ends the journey if it is never reached |
| `sr.press(key)` | Any key, with Playwright key names (`Enter`, `Escape`, `ArrowDown`, `Shift+Tab`…) |
| `sr.activate({ expectDownload })` | Enter, or Space for checkboxes, radios and switches. Optionally wait for a download and check its name |
| `sr.selectOption(label)` | Choose an option in the focused `<select>` |
| `sr.expectFocus({ role, name })` | Check where focus is |
| `sr.expectAnnouncement(textOrRegExp, { within })` | Wait for a live-region announcement, or speech in virtual and voiceover modes |
| `sr.walkTabOrder({ max })` | Tab through the whole page once, recording every stop |
| `sr.readPage({ max })` | Read line by line, like a screen reader's "read next" (virtual and voiceover) |
| `sr.note(text)` | Add a line to the transcript |
| `sr.page` | The Playwright page, for anything else |

A `name` is an exact string (ignoring case and spaces) or a RegExp. Roles are the ARIA roles
Chromium reports: `button`, `link`, `combobox`, `checkbox`, `heading` and so on.

## Targets

- [`targets/stem-accessibility`](targets/stem-accessibility): journeys for the
  [STEM-Accessibility](https://github.com/stem-accessibility/frontend) frontend. `mock.js` fakes
  its backend inside the browser, so journeys run against any build (a local dev server, or a
  pull request's Vercel preview) without touching real data.
- [`targets/generic`](targets/generic): works on any site (the home page's Tab order).

## In CI

- **CI** (`.github/workflows/ci.yml`) tests the tool itself against `test/fixtures/basic.html`.
- **Evaluate a site** (`.github/workflows/evaluate.yml`): start it from the Actions tab with a site
  address, or call it from another repository:
  ```yaml
  jobs:
    screen-reader:
      uses: pisan-labs/screen-reader-journeys/.github/workflows/evaluate.yml@main
      with:
        base_url: ${{ github.event.deployment_status.environment_url }}
  ```
  The transcripts are kept as a downloadable artifact, and the summary appears on the run's page.
- **VoiceOver** (`.github/workflows/voiceover.yml`): the same with real VoiceOver, on a Mac
  registered as a self-hosted runner. See [docs/voiceover.md](docs/voiceover.md).
- **NVDA** (`.github/workflows/nvda.yml`): real NVDA on a GitHub-hosted Windows runner, the same way:
  the self-test on pull requests that touch the NVDA code, journeys when started by hand.
- **Compare screen readers** (`.github/workflows/compare.yml`): runs the journeys in the walker,
  the emulated screen reader, Orca and NVDA, then compares them. Start it from the Actions tab
  with a site address, or call it from another repository as above, with `compare.yml`. The
  artifact `screen-reader-comparison` holds every run's reports and the comparison.
- **Orca** (`.github/workflows/orca.yml`): real Orca on a GitHub-hosted Ubuntu 26.04 runner. It runs
  the Orca self-test on pull requests that touch the Orca code; start it by hand with a site address
  for journeys. Locally, on Ubuntu 26.04 or later:
  ```bash
  npx @guidepup/setup setup --ci
  ```
  ```bash
  xvfb-run -a dbus-run-session -- node src/cli.js run targets/stem-accessibility --base-url URL --mode orca
  ```

## What the automatic findings mean

| Rule | Level | Meaning |
|---|---|---|
| `focus-in-aria-hidden` | error | Focus lands inside `aria-hidden`, so a screen reader user is on something they cannot hear |
| `no-name` | error | A focusable element has no accessible name |
| `keyboard-trap` | error | Tab does not move focus away |
| `no-role` | warning | A focusable element has no role (for example a `div` with `tabindex`) |
| `focus-indicator` | warning | No outline or box-shadow when focused. A heuristic: check by eye, since other styles are not detected |
| `invisible-focus` | warning | The focused element has no size on screen |
| `long-tab-order` | warning | The Tab order did not come back round within the limit |

Announcements are an approximation. The walker reports a live region's whole text after each
change; real screen readers also apply `aria-atomic`, `aria-relevant` and their own timing.

## Licence

MIT, see [LICENSE](LICENSE). Third-party code and dependencies are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
