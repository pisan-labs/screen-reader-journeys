// The three ways of "listening" to a page. Each driver presses keys and reports what a screen
// reader user would hear. All of them use the real browser keyboard, so focus moves exactly as
// it does for a keyboard user.
//
//   walker     Chromium's accessibility tree: the role, name and states of each focus stop, plus
//              live-region announcements. Fast, runs anywhere, no speech engine.
//   virtual    Guidepup's Virtual Screen Reader running inside the page: an emulated screen
//              reader that follows focus and live regions and can read the page line by line.
//   voiceover  Real VoiceOver on macOS through Guidepup, with Playwright's WebKit. Needs a
//              logged-in Mac set up as described in docs/voiceover.md.

import { createRequire } from "node:module";
import { describeFocusChromium, describeFocusPortable, speakFocus } from "./focus.js";

const require = createRequire(import.meta.url);

/** Let the app react to a key press: two animation frames and a short pause. */
export async function settle(page, ms = 150) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(ms);
}

const focusId = (focus) => `${focus.selector}|${focus.domId}`;

class WalkerDriver {
  static id = "walker";
  static label = "Keyboard walker (Chromium accessibility tree)";
  static browser = "chromium";

  constructor(page) {
    this.page = page;
  }

  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    await this.cdp.send("Accessibility.enable");
    this.lastFocus = await this.focus();
    await this.collect(); // drop announcements made while the page loaded
  }

  focus() {
    return describeFocusChromium(this.page, this.cdp);
  }

  async collect() {
    const items = await this.page.evaluate(() => window.__srj?.take() ?? []);
    return items.map((a) =>
      a.hidden ? `(not announced, the region is hidden: ${a.text})` : `${a.politeness === "assertive" ? "alert" : "status"}: ${a.text}`
    );
  }

  async press(key) {
    await this.page.keyboard.press(key);
    await settle(this.page);
    const focus = await this.focus();
    const spoken = [];
    if (focusId(focus) !== focusId(this.lastFocus)) spoken.push(speakFocus(focus));
    this.lastFocus = focus;
    spoken.push(...(await this.collect()));
    return { focus, spoken };
  }

  async next() {
    return { spoken: [], unsupported: "Reading line by line needs the virtual or voiceover mode." };
  }

  async stop() {}
}

let virtualBundle = null;
/** Guidepup's browser build, wrapped as a script that defines window.__srjVirtualLib. */
async function loadVirtualBundle() {
  if (!virtualBundle) {
    const { build } = await import("esbuild");
    const entry = require.resolve("@guidepup/virtual-screen-reader/browser.js");
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: "iife",
      globalName: "__srjVirtualLib",
      platform: "browser",
      write: false,
      logLevel: "silent",
    });
    virtualBundle = result.outputFiles[0].text;
  }
  return virtualBundle;
}

class VirtualDriver extends WalkerDriver {
  static id = "virtual";
  static label = "Emulated screen reader (Guidepup Virtual Screen Reader, in Chromium)";
  static browser = "chromium";

  async start() {
    this.cdp = await this.page.context().newCDPSession(this.page);
    await this.cdp.send("Accessibility.enable");
    await this.page.addScriptTag({ content: await loadVirtualBundle() });
    await this.page.evaluate(() => window.__srjVirtualLib.virtual.start({ container: document.body }));
    this.seen = 0;
    this.lastFocus = await this.focus();
    await this.collect(); // the start-up phrases ("document")
  }

  async collect() {
    const log = await this.page.evaluate(() => window.__srjVirtualLib.virtual.spokenPhraseLog());
    const fresh = log.slice(this.seen);
    this.seen = log.length;
    return fresh;
  }

  async press(key) {
    await this.page.keyboard.press(key);
    await settle(this.page);
    const focus = await this.focus();
    this.lastFocus = focus;
    return { focus, spoken: await this.collect() };
  }

  async next() {
    await this.page.evaluate(() => window.__srjVirtualLib.virtual.next());
    return { spoken: await this.collect() };
  }

  async stop() {
    await this.page.evaluate(() => window.__srjVirtualLib?.virtual.stop()).catch(() => {});
  }
}

class VoiceOverDriver {
  static id = "voiceover";
  static label = "VoiceOver (macOS, Playwright WebKit)";
  static browser = "webkit";
  static headed = true;

  constructor(page) {
    this.page = page;
  }

  async start() {
    if (process.platform !== "darwin") throw new Error("The voiceover mode runs only on macOS.");
    const { voiceOver } = await import("@guidepup/guidepup");
    const { navigateVoiceOverToWebContent } = await import("./voiceover-web-content.js");
    this.vo = voiceOver;
    await voiceOver.start({ capture: "initial" });
    await navigateVoiceOverToWebContent({ voiceOver, page: this.page, applicationId: "org.webkit.Playwright" });
    this.seen = (await voiceOver.spokenPhraseLog()).length;
    this.lastFocus = await describeFocusPortable(this.page);
  }

  focus() {
    return describeFocusPortable(this.page);
  }

  async collect() {
    const log = await this.vo.spokenPhraseLog();
    const fresh = log.slice(this.seen);
    this.seen = log.length;
    return fresh;
  }

  async press(key) {
    await this.vo.press(key);
    await settle(this.page, 400);
    const focus = await describeFocusPortable(this.page);
    this.lastFocus = focus;
    return { focus, spoken: await this.collect() };
  }

  async next() {
    await this.vo.next();
    return { spoken: await this.collect() };
  }

  async stop() {
    try {
      await this.vo?.stop();
    } catch {
      // VoiceOver may already be off.
    }
  }
}

export const DRIVERS = { walker: WalkerDriver, virtual: VirtualDriver, voiceover: VoiceOverDriver };
