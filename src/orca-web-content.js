// Bring Orca to the browser window and put its cursor at the start of the page.
//
// Adapted from @guidepup/playwright (lib/navigateOrcaToWebContent.js and lib/cleanString.js),
// MIT License, Copyright (c) 2023 Craig Morten. Used here without @playwright/test.

import { execFileSync } from "node:child_process";
import guidepup from "@guidepup/guidepup";

const { orcaKeyCodeCommands } = guidepup;
const MAX_SWITCHES = 10;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (text) =>
  text
    .toLowerCase()
    .replace(/[|¦:;'"`\-‐–—·_()[\]{}\\^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Switch windows (Alt+Tab) until Orca reports the page's title as the active window. */
async function focusBrowserWindow(orca, pageTitle) {
  const title = clean(pageTitle);
  if (!title) throw new Error("The page needs a <title> so Orca can find its window.");
  for (let attempt = 0; attempt <= MAX_SWITCHES; attempt++) {
    await orca.clearSpokenPhraseLog();
    await orca.perform(orcaKeyCodeCommands.PresentTitle, { capture: "initial" });
    if (clean(await orca.lastSpokenPhrase()).includes(title)) return;
    if (attempt < MAX_SWITCHES) {
      execFileSync("xdotool", ["key", "--clearmodifiers", "alt+Tab"]);
      await delay(100);
    }
  }
  throw new Error(`Orca could not find the window titled "${pageTitle}" after ${MAX_SWITCHES} tries.`);
}

export async function navigateOrcaToWebContent({ orca, page }) {
  await focusBrowserWindow(orca, await page.title());
  await page.bringToFront();
  await page.locator("body").waitFor();
  await page.locator("body").focus();
  await page.locator("body").click();
  await page.locator("body").blur();
  await orca.perform(orcaKeyCodeCommands.StartOfFile, { capture: "initial" });
  await orca.clearSpokenPhraseLog();
}
