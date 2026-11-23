# Example reports

Real output from the STEM-Accessibility journeys, with the backend faked in the browser
(`targets/stem-accessibility/mock.js`), and in the last row from this repository's test page.
Recorded on 2026-11-23.

| Report | Build tested | What it shows |
|---|---|---|
| [braille-download.virtual.braille-branch.md](braille-download.virtual.braille-branch.md) | Local dev server of the braille pull request (stem-accessibility/frontend#9) | The emulated screen reader's speech through the whole journey, ending with "Downloaded lab-2-loops.brf, 2 braille pages." Also one tool error: a bug in the emulator, not the site |
| [summary-tab-order.walker.main-preview.md](summary-tab-order.walker.main-preview.md) | The live Vercel preview of `main` (via stem-accessibility/frontend#19) | The hidden visual flowchart's edges, nodes and zoom buttons are Tab stops inside `aria-hidden` (6 errors) |
| [summary-tab-order.walker.pr16.md](summary-tab-order.walker.pr16.md) | Local dev server of stem-accessibility/frontend#16 | The same journey with that fix: no findings, and 14 Tab stops, all with names |
| [compare.walker-virtual.fixture.md](compare.walker-virtual.fixture.md) | This repository's test page, [`test/fixtures/basic.html`](../../test/fixtures/basic.html) | `srj compare`: the walker and the emulated screen reader side by side. The emulator is silent on the `aria-hidden` button and the clickable `div`, which the walker reaches by Tab |

On `main`, the Braille journey fails at "Choose 'Braille (.brf)'", because the Braille view
arrives with #9.
