// Runs one journey in one mode and records what was heard at each step.

import { pathToFileURL } from "node:url";
import { chromium, webkit } from "playwright";
import { DRIVERS, settle } from "./drivers.js";
import { installRecorder } from "./recorder.js";
import { checkFocus, describeMatcher, matchesFocus, speakFocus } from "./focus.js";

/** Thrown to end a journey early when a later step cannot make sense (for example, a control was never reached). */
class StopJourney extends Error {}

export async function loadJourney(file) {
  const journey = (await import(pathToFileURL(file).href)).default;
  for (const key of ["name", "start", "run"]) {
    if (!journey?.[key]) throw new Error(`${file}: a journey needs "${key}"`);
  }
  return { ...journey, file };
}

const matches = (text, pattern) =>
  pattern instanceof RegExp ? pattern.test(text) : text.toLowerCase().includes(String(pattern).toLowerCase());

/** The commands a journey uses. Every key press goes through the real browser keyboard. */
class Session {
  constructor(page, driver, result) {
    this.page = page;
    this.driver = driver;
    this.result = result;
    this.findingIndex = new Map();
  }

  get mode() {
    return this.result.mode;
  }

  /** The step just recorded. */
  get last() {
    return this.result.steps.at(-1);
  }

  record(action, focus, spoken = []) {
    const step = {
      n: this.result.steps.length + 1,
      action,
      focus: focus ? { spoken: speakFocus(focus), role: focus.role, name: focus.name, selector: focus.selector } : null,
      spoken,
    };
    this.result.steps.push(step);
    if (focus) for (const finding of checkFocus(focus)) this.addFinding(finding, focus, step.n);
    return step;
  }

  addFinding(finding, focus, step) {
    // Group by rule and element type, so e.g. every edge of a diagram counts as one finding.
    const key = `${finding.rule}|${focus?.selector}`;
    const existing = this.findingIndex.get(key);
    if (existing) {
      existing.count += 1;
      return;
    }
    const spoken = focus ? speakFocus(focus) : "";
    const short = spoken.length > 90 ? `${spoken.slice(0, 87)}…` : spoken;
    const entry = { ...finding, element: focus ? `${short} (${focus.selector})` : null, step, count: 1 };
    this.findingIndex.set(key, entry);
    this.result.findings.push(entry);
  }

  expect(ok, text, detail) {
    this.result.expectations.push({ ok: !!ok, text, detail: detail ?? null, step: this.result.steps.length });
    return !!ok;
  }

  note(text) {
    this.record(`note: ${text}`, null, []);
  }

  /** Press a key (Playwright key names: "Tab", "Shift+Tab", "Enter", "ArrowDown", "Escape", "Space"…). */
  async press(key, label = key) {
    const { focus, spoken } = await this.driver.press(key);
    this.record(label, focus, spoken);
    return focus;
  }

  async tab(times = 1) {
    let focus;
    for (let i = 0; i < times; i++) focus = await this.press("Tab");
    return focus;
  }

  async shiftTab(times = 1) {
    let focus;
    for (let i = 0; i < times; i++) focus = await this.press("Shift+Tab");
    return focus;
  }

  /** Press Tab until focus is on `{ role, name }`. Ends the journey if it is never reached. */
  async tabTo(matcher, { max = 60, backwards = false } = {}) {
    for (let i = 0; i < max; i++) {
      const focus = await this.press(backwards ? "Shift+Tab" : "Tab");
      if (matchesFocus(focus, matcher)) {
        this.expect(true, `Reach ${describeMatcher(matcher)} with ${backwards ? "Shift+Tab" : "Tab"}`, `${i + 1} presses`);
        return focus;
      }
    }
    this.expect(false, `Reach ${describeMatcher(matcher)} with ${backwards ? "Shift+Tab" : "Tab"}`, `not reached in ${max} presses`);
    throw new StopJourney(`Could not reach ${describeMatcher(matcher)}`);
  }

  async expectFocus(matcher) {
    const focus = this.driver.lastFocus;
    return this.expect(matchesFocus(focus, matcher), `Focus is on ${describeMatcher(matcher)}`, speakFocus(focus));
  }

  /**
   * Activate the focused control the way a keyboard user would: Space for checkboxes, radios and
   * switches, Enter otherwise. With `expectDownload` (true, a string or a RegExp for the file
   * name), waits for the download and checks its name.
   */
  /** @param {{ expectDownload?: boolean | string | RegExp }} [options] */
  async activate({ expectDownload } = {}) {
    const role = this.driver.lastFocus?.role;
    const key = ["checkbox", "radio", "switch"].includes(role) ? "Space" : "Enter";
    if (!expectDownload) return this.press(key);
    try {
      const [download] = await Promise.all([this.page.waitForEvent("download", { timeout: 10000 }), this.press(key)]);
      const name = download.suggestedFilename();
      this.last.spoken.push(`(download: ${name})`);
      const ok = expectDownload === true || matches(name, expectDownload);
      this.expect(ok, `A file downloads${expectDownload === true ? "" : ` matching ${expectDownload}`}`, name);
      return name;
    } catch (error) {
      this.expect(false, "A file downloads", error.message.split("\n")[0]);
      return null;
    }
  }

  /** Choose an option in the focused <select> by its label (as arrow keys would, without opening the list). */
  async selectOption(label) {
    try {
      await this.page.locator(":focus").selectOption({ label }, { timeout: 2000 });
    } catch {
      this.expect(false, `Choose "${label}" in the focused list`, "no such option");
      throw new StopJourney(`No option "${label}"`);
    }
    await settle(this.page);
    const focus = await this.driver.focus?.();
    this.record(`choose "${label}"`, focus ?? null, await this.driver.collect());
  }

  /** Wait up to `within` ms for something to be announced (a live region, or speech in the virtual and voiceover modes). */
  async expectAnnouncement(pattern, { within = 5000 } = {}) {
    const step = this.last;
    const deadline = Date.now() + within;
    for (;;) {
      if (step.spoken.some((line) => matches(line, pattern))) {
        return this.expect(true, `Announced: ${pattern}`, step.spoken.find((line) => matches(line, pattern)));
      }
      if (Date.now() > deadline) {
        return this.expect(false, `Announced: ${pattern}`, step.spoken.length ? `heard: ${step.spoken.join(" / ")}` : "nothing announced");
      }
      await this.page.waitForTimeout(200);
      step.spoken.push(...(await this.driver.collect()));
    }
  }

  /** Tab through the whole page once, recording every stop. Stops when focus comes back round or leaves the page. */
  async walkTabOrder({ max = 150 } = {}) {
    const seen = new Set();
    let previous = this.driver.lastFocus?.domId;
    for (let i = 0; i < max; i++) {
      const focus = await this.press("Tab");
      if (focus.domId === previous && !focus.isBody) {
        this.addFinding({ level: "error", rule: "keyboard-trap", message: "Tab does not move focus away from this element (a keyboard trap?)." }, focus, this.last.n);
        return;
      }
      if (focus.isBody || seen.has(focus.domId)) {
        this.note(`Tab order: ${seen.size} stops`);
        return;
      }
      seen.add(focus.domId);
      previous = focus.domId;
    }
    this.addFinding({ level: "warning", rule: "long-tab-order", message: `Tab order did not come back round within ${max} stops.` }, null, this.last.n);
  }

  /** Read the page line by line, as a screen reader's "read next" does (virtual and voiceover modes). */
  async readPage({ max = 400 } = {}) {
    for (let i = 0; i < max; i++) {
      const { spoken, unsupported } = await this.driver.next();
      if (unsupported) {
        this.note(unsupported);
        return;
      }
      this.record("read next", null, spoken);
      if (spoken.some((line) => /end of document/i.test(line))) return;
    }
  }
}

/**
 * Run one journey in one mode. `baseUrl` is the site under test, e.g. a pull request's preview.
 * `launchOptions` go to Playwright's browser launch (the hosted server uses them for its network
 * guard proxy).
 */
/**
 * @param {any} journey
 * @param {{ mode: string, baseUrl: string, headed?: boolean, launchOptions?: { args?: string[], [key: string]: any } }} options
 */
export async function runJourney(journey, { mode, baseUrl, headed = false, launchOptions = {} }) {
  const Driver = DRIVERS[mode];
  if (!Driver) throw new Error(`Unknown mode "${mode}". Modes: ${Object.keys(DRIVERS).join(", ")}`);
  const url = new URL(journey.start, baseUrl).href;
  const result = {
    journey: journey.name,
    description: journey.description ?? "",
    file: journey.file,
    mode,
    modeLabel: Driver.label,
    url,
    startedAt: new Date().toISOString(),
    status: "pass",
    steps: [],
    expectations: [],
    findings: [],
    pageErrors: [],
    toolErrors: [],
  };
  // A real screen reader may need to run before the browser starts (Orca), so the driver exists
  // first and gets the page once it is open.
  const driver = new Driver(null);
  let browser;
  try {
    await driver.beforeBrowser?.();
    browser = await (Driver.browser === "webkit" ? webkit : chromium).launch({
      headless: !(headed || Driver.headed),
      ...launchOptions,
      args: [...(Driver.launchArgs ?? []), ...(launchOptions.args ?? [])],
    });
    result.browser = `${Driver.browser} ${browser.version()}`;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      bypassCSP: true,
      acceptDownloads: true,
      reducedMotion: "reduce",
    });
    await context.addInitScript(installRecorder);
    const page = await context.newPage();
    // Errors thrown from an anonymous script come from code this tool injects (the Virtual Screen
    // Reader), not from the site, whose scripts load from URLs.
    page.on("pageerror", (error) => {
      const firstFrame = (error.stack ?? "").split("\n").find((line) => line.trim().startsWith("at ")) ?? "";
      const list = /<anonymous>:\d+/.test(firstFrame) ? result.toolErrors : result.pageErrors;
      list.push(String(error).split("\n")[0]);
    });
    if (journey.setup) await journey.setup(page);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    if (journey.ready) await page.locator(journey.ready).first().waitFor({ timeout: 20000 });
    await settle(page, 300);
    driver.page = page;
    await driver.start();
    await journey.run(new Session(page, driver, result));
  } catch (error) {
    if (!(error instanceof StopJourney)) {
      result.status = "error";
      result.error = error.message.split("\n")[0];
    }
  } finally {
    await driver.stop();
    await browser?.close();
  }
  if (result.status === "pass" && result.expectations.some((e) => !e.ok)) result.status = "fail";
  return result;
}
