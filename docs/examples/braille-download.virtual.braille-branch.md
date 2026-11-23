# Shared STEM image: download the braille file

A keyboard and screen reader user opens a shared STEM image, chooses the Braille (.brf) representation, downloads the file and hears that it downloaded. Needs the braille pull request (stem-accessibility/frontend#9).

- **Result:** ✅ pass
- **Mode:** Emulated screen reader (Guidepup Virtual Screen Reader, in Chromium), chromium 157.0.8103.78
- **Page:** http://localhost:5199/p/srj-demo
- **Checks:** 4 of 4 passed
- **Findings:** 0 errors, 0 warnings
- **Run:** 2026-11-23T08:49:05.567Z

## Checks

- ✅ Reach combobox /choose a representation/i with Tab: 8 presses (step 8)
- ✅ Reach button /download braille file/i with Tab: 1 presses (step 10)
- ✅ A file downloads matching /\.brf$/: lab-2-loops.brf (step 11)
- ✅ Announced: /downloaded .*\.brf/i: polite: Downloaded lab-2-loops.brf, 2 braille pages. (step 11)

## Findings

None.

## Transcript

What a screen reader user would hear after each action. In walker mode this is the focused
element's role, name and states plus live-region announcements; in virtual and voiceover modes
it is the screen reader's own speech.

| # | Action | Heard |
|---|---|---|
| 1 | Tab | link, Skip to main content |
| 2 | Tab | link, STEM-Accessibility home |
| 3 | Tab | link, About |
| 4 | Tab | link, Browse |
| 5 | Tab | link, Try it |
| 6 | Tab | link, Log in |
| 7 | Tab | link, STEM-Accessibility |
| 8 | Tab | combobox, Choose a representation:, summary, has popup listbox, not expanded |
| 9 | choose "Braille (.brf)" | — |
| 10 | Tab | button, Download braille file (.brf) |
| 11 | Enter | polite: Downloaded lab-2-loops.brf, 2 braille pages. / (download: lab-2-loops.brf) |

## Tool errors

Errors from code this tool injects (the emulated screen reader), not from the site. The
transcript around them may be missing an announcement.

- TypeError: a.getElementById is not a function
