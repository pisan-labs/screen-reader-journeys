# Running with real VoiceOver on a Mac

The `voiceover` mode drives macOS VoiceOver through [Guidepup](https://github.com/guidepup/guidepup)
and records what VoiceOver says. It runs on a Mac only, with someone logged in. The steps below
are written for halflife (the always-on Mac) or a laptop.

> **Not yet tried on a Mac.** The code follows Guidepup's own Playwright integration, but this
> mode was written on Linux and has not run yet. Expect to adjust it on the first run.

## What to expect while it runs

- VoiceOver speaks aloud and moves focus. Mute the Mac if others are nearby.
- It takes over the keyboard and the frontmost window, so don't use the Mac during a run. On
  halflife, run it when its scheduled jobs are idle, for example at night.
- It needs a **logged-in desktop session**. It does not work from SSH alone, or from a runner
  installed as a system service (LaunchDaemon) without a user session.

## One-time setup

1. Install Node.js 22 and clone this repository, then:
   ```bash
   npm ci
   ```
   ```bash
   npx playwright install webkit
   ```
2. Let VoiceOver be automated. Guidepup's setup does this:
   ```bash
   npx @guidepup/setup
   ```
   It changes system settings, so read its output. It turns on "Allow VoiceOver to be controlled
   with AppleScript" (also in VoiceOver Utility → General), and it may ask for your password.
3. When macOS asks, allow the app that starts the run (Terminal, or the GitHub runner) under
   System Settings → Privacy & Security, in both **Accessibility** and **Automation**.

## Run it by hand

```bash
node src/cli.js run targets/stem-accessibility --base-url https://frontend-git-<branch>-stem-accessibility.vercel.app --mode voiceover
```

Reports are written to `reports/`, the same as the other modes.

## Run it from GitHub Actions (optional)

1. In this repository: Settings → Actions → Runners → **New self-hosted runner** → macOS. Follow
   the steps, and add the label `voiceover`.
2. Start the runner **in the logged-in session**: run `./run.sh` in a Terminal window, or set it
   up as a LaunchAgent (per user), not a LaunchDaemon.
3. Actions tab → **VoiceOver** → Run workflow, with the site's address.

The workflow allows one run at a time. A self-hosted runner executes the code of whatever
workflow it is given, so keep it registered to this repository only, and don't let workflows
from forks run on it.
