# Shared STEM image: Tab through the Summary view

Every Tab stop on a shared image's Summary view, with what a screen reader says at each. The visual flowchart is hidden from screen readers, so none of its parts should be a Tab stop (fixed by stem-accessibility/frontend#16).

- **Result:** ✅ pass
- **Mode:** Keyboard walker (Chromium accessibility tree), chromium 157.0.8103.78
- **Page:** https://frontend-git-claude-vigilant-einstein-f2spjo-stem-accessibility.vercel.app/p/srj-demo?view=summary
- **Checks:** 0 of 0 passed
- **Findings:** 6 errors, 2 warnings
- **Run:** 2026-11-23T08:46:04.960Z

## Checks

None.

## Findings

- **error** `focus-in-aria-hidden`: Keyboard focus lands inside aria-hidden content, so screen readers cannot announce it. At Edge from A to B, group, Press enter or space to select an edge. You can then press del… (g) (4 times), first at step 9.
- **warning** `focus-indicator`: No focus indicator found (no outline or box-shadow when focused). Check it by eye; other styles are not detected. At Edge from A to B, group, Press enter or space to select an edge. You can then press del… (g) (4 times), first at step 9.
- **warning** `invisible-focus`: The focused element has no size on screen. At Edge from A to B, group, Press enter or space to select an edge. You can then press del… (g), first at step 9.
- **error** `focus-in-aria-hidden`: Keyboard focus lands inside aria-hidden content, so screen readers cannot announce it. At group, Press enter or space to select a node. You can then use the arrow keys to move t… (div.react-flow__node.react-flow__node-shape) (4 times), first at step 13.
- **error** `focus-in-aria-hidden`: Keyboard focus lands inside aria-hidden content, so screen readers cannot announce it. At Zoom In, button, Zoom In (button.react-flow__controls-button.react-flow__controls-zoomin), first at step 17.
- **error** `focus-in-aria-hidden`: Keyboard focus lands inside aria-hidden content, so screen readers cannot announce it. At Zoom Out, button, Zoom Out (button.react-flow__controls-button.react-flow__controls-zoomout), first at step 18.
- **error** `focus-in-aria-hidden`: Keyboard focus lands inside aria-hidden content, so screen readers cannot announce it. At Fit View, button, Fit View (button.react-flow__controls-button.react-flow__controls-fitview), first at step 19.
- **error** `focus-in-aria-hidden`: Keyboard focus lands inside aria-hidden content, so screen readers cannot announce it. At Toggle Interactivity, button, Toggle Interactivity (button.react-flow__controls-button.react-flow__controls-interactive), first at step 20.

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
| 9 | Tab | Edge from A to B, group, Press enter or space to select an edge. You can then press delete to remove it or escape to cancel. |
| 10 | Tab | Edge from B to C, group, Press enter or space to select an edge. You can then press delete to remove it or escape to cancel. |
| 11 | Tab | Edge from B to D, group, Press enter or space to select an edge. You can then press delete to remove it or escape to cancel. |
| 12 | Tab | Edge from D to B, group, Press enter or space to select an edge. You can then press delete to remove it or escape to cancel. |
| 13 | Tab | group, Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel. |
| 14 | Tab | group, Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel. |
| 15 | Tab | group, Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel. |
| 16 | Tab | group, Press enter or space to select a node. You can then use the arrow keys to move the node around. Press delete to remove it and escape to cancel. |
| 17 | Tab | Zoom In, button, Zoom In |
| 18 | Tab | Zoom Out, button, Zoom Out |
| 19 | Tab | Fit View, button, Fit View |
| 20 | Tab | Toggle Interactivity, button, Toggle Interactivity |
| 21 | Tab | stem-accessibility@uw.edu, link |
| 22 | Tab | Source code on GitHub (opens in a new tab), link |
| 23 | Tab | Submit an issue (opens in a new tab), link |
| 24 | Tab | Arboretum (opens in a new tab), link |
| 25 | Tab | paper (opens in a new tab), link |
| 26 | Tab | Olli (opens in a new tab), link |
| 27 | Tab | (nothing focused) |
| 28 | note: Tab order: 26 stops | — |
