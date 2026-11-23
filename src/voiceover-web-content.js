// Move VoiceOver's cursor into the page's web content, so key presses and reading start there.
//
// Adapted from @guidepup/playwright (lib/navigateVoiceOverToWebContent.js), MIT License,
// Copyright (c) 2023 Craig Morten. Used here without @playwright/test.

import guidepup from "@guidepup/guidepup";

const { MacOSKeyCodes, macOSActivateId, voiceOverKeyCodeCommands } = guidepup;
const MAX_ATTEMPTS = 10;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const cancel = (vo) => vo.perform({ keyCode: MacOSKeyCodes.Control }, { capture: false });
const closeMenus = (vo) => vo.perform({ keyCode: MacOSKeyCodes.Escape }, { capture: false });

async function openItemChooser(vo) {
  let last = "";
  while (!last.toLowerCase().includes("item chooser")) {
    await cancel(vo);
    await delay(100);
    await closeMenus(vo);
    await delay(100);
    await vo.perform(voiceOverKeyCodeCommands.openItemChooser, { capture: true });
    last = await vo.lastSpokenPhrase();
  }
}

async function selectWebContent(vo) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    for (const character of "web content") {
      await cancel(vo);
      await delay(100);
      await vo.type(character, { capture: "initial" });
      if ((await vo.lastSpokenPhrase()).toLowerCase().includes("web content")) {
        await vo.perform({ keyCode: MacOSKeyCodes.Enter }, { capture: false });
        return;
      }
    }
    await vo.perform({ keyCode: MacOSKeyCodes.Backspace }, { capture: false });
    await delay(100);
  }
  throw new Error(`Could not find "web content" in VoiceOver's Item Chooser after ${MAX_ATTEMPTS} attempts.`);
}

export async function navigateVoiceOverToWebContent({ voiceOver: vo, page, applicationId }) {
  await macOSActivateId(applicationId);
  await cancel(vo);
  await delay(100);
  await page.bringToFront();
  await page.locator("body").waitFor();
  await page.evaluate(() => {
    const marker = document.createElement("input");
    marker.id = "__srj_marker__";
    marker.readOnly = true;
    marker.tabIndex = -1;
    marker.setAttribute("aria-label", "Guidepup Marker");
    marker.style.cssText = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)";
    document.body.prepend(marker);
  });
  try {
    await openItemChooser(vo);
    await selectWebContent(vo);
    await vo.interact({ capture: false });
    await delay(100);
    await vo.clearSpokenPhraseLog();
    await vo.clearItemTextLog();
  } finally {
    await page.evaluate(() => document.getElementById("__srj_marker__")?.remove());
  }
}
