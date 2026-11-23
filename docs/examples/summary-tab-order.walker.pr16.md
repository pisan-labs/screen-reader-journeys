# Shared STEM image: Tab through the Summary view

Every Tab stop on a shared image's Summary view, with what a screen reader says at each. The visual flowchart is hidden from screen readers, so none of its parts should be a Tab stop (fixed by stem-accessibility/frontend#16).

- **Result:** ✅ pass
- **Mode:** Keyboard walker (Chromium accessibility tree), chromium 157.0.8103.78
- **Page:** http://localhost:5201/p/srj-demo?view=summary
- **Checks:** 0 of 0 passed
- **Findings:** 0 errors, 0 warnings
- **Run:** 2026-11-23T08:48:38.819Z

## Checks

None.

## Findings

None.

## Transcript

What a screen reader user would hear after each action. In walker mode this is the focused
element's role, name and states plus live-region announcements; in virtual and voiceover modes
it is the screen reader's own speech.

| # | Action | Heard |
|---|---|---|
| 1 | Tab | Skip to main content, link |
| 2 | Tab | STEM-Accessibility home, link |
| 3 | Tab | About, link |
| 4 | Tab | Browse, link |
| 5 | Tab | Try it, link |
| 6 | Tab | Log in, link |
| 7 | Tab | STEM-Accessibility, link |
| 8 | Tab | Choose a representation:, combobox, collapsed |
| 9 | Tab | stem-accessibility@uw.edu, link |
| 10 | Tab | Source code on GitHub (opens in a new tab), link |
| 11 | Tab | Submit an issue (opens in a new tab), link |
| 12 | Tab | Arboretum (opens in a new tab), link |
| 13 | Tab | paper (opens in a new tab), link |
| 14 | Tab | Olli (opens in a new tab), link |
| 15 | Tab | (nothing focused) |
| 16 | note: Tab order: 14 stops | — |
