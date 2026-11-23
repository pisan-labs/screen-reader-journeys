// Bring NVDA to the browser window and put it in browse mode at the top of the page.
//
// Adapted from @guidepup/playwright (lib/navigateNVDAtoWebContent.js and lib/cleanString.js),
// MIT License, Copyright (c) 2023 Craig Morten. Used here without @playwright/test.

import guidepup from "@guidepup/guidepup";

const { NVDAKeyCodeCommands, WindowsKeyCodes, WindowsModifiers } = guidepup;
const MAX_SWITCHES = 10;
const SWITCH_APPLICATION = { keyCode: [WindowsKeyCodes.Escape], modifiers: [WindowsModifiers.Alt] };
const MOVE_TO_TOP = { keyCode: [WindowsKeyCodes.Home], modifiers: [WindowsModifiers.Control] };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (text) =>
  text
    .toLowerCase()
    .replace(/[|¦:;'"`\-‐–—·_()[\]{}\\^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const hasBrowserFocus = (applicationName, pageTitle, windowTitle) => {
  const title = clean(pageTitle);
  const win = clean(windowTitle);
  return (title.length > 0 && win.startsWith(title)) || win.includes(clean(applicationName));
};

async function focusBrowser(nvda, applicationName, pageTitle) {
  for (let attempt = 0; attempt <= MAX_SWITCHES; attempt++) {
    await nvda.perform(NVDAKeyCodeCommands.reportTitle);
    if (hasBrowserFocus(applicationName, pageTitle, await nvda.lastSpokenPhrase())) return;
    if (attempt < MAX_SWITCHES) {
      await nvda.perform(SWITCH_APPLICATION, { capture: false });
      await delay(500);
    }
  }
  throw new Error(`NVDA could not find the window "${applicationName}" or "${pageTitle}" after ${MAX_SWITCHES} tries.`);
}

export async function navigateNvdaToWebContent({ nvda, page, applicationName = "Google Chrome For Testing" }) {
  await nvda.perform(NVDAKeyCodeCommands.exitFocusMode, { capture: false });
  await delay(100);
  await focusBrowser(nvda, applicationName, await page.title());
  await page.bringToFront();
  await page.locator("body").waitFor();
  await page.locator("body").focus();
  await page.locator("body").click();
  await page.locator("body").blur();
  // Toggling browse and focus mode once settles NVDA in browse mode after the window switch.
  await nvda.perform(NVDAKeyCodeCommands.readNextFocusableItem, { capture: false });
  await delay(100);
  await nvda.perform(NVDAKeyCodeCommands.toggleBetweenBrowseAndFocusMode, { capture: false });
  await delay(100);
  await nvda.perform(NVDAKeyCodeCommands.toggleBetweenBrowseAndFocusMode, { capture: false });
  await delay(100);
  await nvda.perform(NVDAKeyCodeCommands.exitFocusMode, { capture: false });
  await delay(100);
  await nvda.perform(MOVE_TO_TOP, { capture: false });
  await nvda.clearSpokenPhraseLog();
  await nvda.clearItemTextLog();
}
