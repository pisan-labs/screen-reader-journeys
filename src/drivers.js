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
//   orca       Real Orca on Linux through Guidepup, with Chromium. Needs Guidepup's setup
//              (Ubuntu 26.04 or later); see .github/workflows/orca.yml.

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
    await this.page?.evaluate(() => window.__srjVirtualLib?.virtual.stop()).catch(() => {});
  }
}

/** Shared parts of the real screen readers driven through Guidepup. */
class GuidepupDriver {
  static headed = true;

  constructor(page) {
    this.page = page;
  }

  /** Called before the browser starts (Orca must be running first so Chromium joins its accessibility bus). */
  async beforeBrowser() {}

  focus() {
    return describeFocusPortable(this.page);
  }

  async collect() {
    const log = await this.sr.spokenPhraseLog();
    const fresh = log.slice(this.seen);
    this.seen = log.length;
    return fresh;
  }

  async press(key) {
    await this.sr.press(key);
    await settle(this.page, 400);
    const focus = await this.focus();
    this.lastFocus = focus;
    return { focus, spoken: await this.collect() };
  }

  async next() {
    await this.sr.next();
    return { spoken: await this.collect() };
  }

  async stop() {
    try {
      await this.sr?.stop();
    } catch {
      // The screen reader may already be off.
    }
  }
}

class VoiceOverDriver extends GuidepupDriver {
  static id = "voiceover";
  static label = "VoiceOver (macOS, Playwright WebKit)";
  static browser = "webkit";

  async start() {
    if (process.platform !== "darwin") throw new Error("The voiceover mode runs only on macOS.");
    const { voiceOver } = await import("@guidepup/guidepup");
    const { navigateVoiceOverToWebContent } = await import("./voiceover-web-content.js");
    this.sr = voiceOver;
    await voiceOver.start({ capture: "initial" });
    await navigateVoiceOverToWebContent({ voiceOver, page: this.page, applicationId: "org.webkit.Playwright" });
    this.seen = (await voiceOver.spokenPhraseLog()).length;
    this.lastFocus = await this.focus();
  }
}

class OrcaDriver extends GuidepupDriver {
  static id = "orca";
  static label = "Orca (Linux, Chromium)";
  static browser = "chromium";
  // Chromium builds its accessibility tree for assistive technology only when asked.
  static launchArgs = ["--force-renderer-accessibility"];

  async beforeBrowser() {
    if (process.platform !== "linux") throw new Error("The orca mode runs only on Linux.");
    const { orca } = await import("@guidepup/guidepup");
    this.sr = orca;
    await orca.start({ capture: "initial" });
  }

  async start() {
    const { navigateOrcaToWebContent } = await import("./orca-web-content.js");
    this.cdp = await this.page.context().newCDPSession(this.page);
    await this.cdp.send("Accessibility.enable");
    await navigateOrcaToWebContent({ orca: this.sr, page: this.page });
    this.seen = (await this.sr.spokenPhraseLog()).length;
    this.lastFocus = await this.focus();
  }

  focus() {
    return describeFocusChromium(this.page, this.cdp);
  }
}

export const DRIVERS = { walker: WalkerDriver, virtual: VirtualDriver, voiceover: VoiceOverDriver, orca: OrcaDriver };
