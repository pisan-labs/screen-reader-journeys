# Compare modes

What each run heard at the same step of the same journey. **(silent)** means the run was at
that step and heard nothing; **—** means it has no such step. Screen readers differ, so
differences are not always faults; they show where to listen first.

## Basic test page

Save announces a status; the rest of the page has known problems the tool must report.

| Run | Mode | Result | Checks | Errors | Warnings |
|---|---|---|---|---|---|
| walker | Keyboard walker (Chromium accessibility tree), chromium 157.0.8103.78 | ✅ pass | 2/2 | 2 | 3 |
| virtual | Emulated screen reader (Guidepup Virtual Screen Reader, in Chromium), chromium 157.0.8103.78 | ✅ pass | 2/2 | 2 | 3 |

3 of 8 steps differ.

| # | Action | walker | virtual | Differences |
|---|---|---|---|---|
| 1 | Tab | Skip to content, link | link, Skip to content |  |
| 2 | Tab | Save, button | button, Save |  |
| 3 | Enter | status: Saved. | polite: Saved. |  |
| 4 | Tab | button | button |  |
| 5 | Tab | Clickable div, generic | (silent) | silent in virtual |
| 6 | Tab | Hidden button, button | (silent) | silent in virtual |
| 7 | Tab | (nothing focused) | (silent) | silent in virtual |
| 8 | note | Tab order: 3 stops | Tab order: 3 stops |  |
