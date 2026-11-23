// The portable focus reader (src/focus.js describeFocusPortable, used by the real screen reader
// modes) and selectOption, with focus inside an open shadow root. A shadow host matches :focus
// when focus is inside its tree, and comes first in document order; the focused element is the
// last match.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { describeFocusPortable } from "../src/focus.js";
import { serve } from "./server.js";

let site;
let browser;
before(async () => {
  site = await serve(fileURLToPath(new URL("./fixtures/", import.meta.url)));
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  site?.close();
});

describe("the portable focus reader, inside a shadow root", () => {
  it("names the focused link, not the shadow host", async () => {
    const page = await browser.newPage();
    await page.goto(`${site.url}/shadow.html`);
    await page.locator("a", { hasText: "Send an idea" }).focus();
    const focus = await describeFocusPortable(page);
    assert.equal(focus.role, "link");
    assert.equal(focus.name, "Send an idea");
    assert.equal(focus.selector, "a");
    await page.close();
  });

  it("still names an ordinary focused element", async () => {
    const page = await browser.newPage();
    await page.goto(`${site.url}/shadow.html`);
    await page.locator("a", { hasText: "Before the footer" }).focus();
    const focus = await describeFocusPortable(page);
    assert.deepEqual([focus.role, focus.name], ["link", "Before the footer"]);
    await page.close();
  });
});

describe("choosing an option inside a shadow root", () => {
  it("selects in the focused list, not in its shadow host", async () => {
    const { runJourney } = await import("../src/journey.js");
    const journey = {
      name: "Shadow select",
      start: "/shadow-select.html",
      file: "test/focus.test.js",
      async run(sr) {
        await sr.tabTo({ role: "combobox", name: "Size" });
        await sr.selectOption("Large");
        // Checked on the page: the recorder does not yet hear live regions inside shadow roots.
        const value = await sr.page.evaluate(() => document.querySelector("pick-size").shadowRoot.querySelector("select").value);
        sr.expect(value === "Large", "The list inside the shadow root shows Large", value);
      },
    };
    const result = await runJourney(journey, { mode: "walker", baseUrl: site.url });
    assert.equal(result.status, "pass", JSON.stringify(result.expectations.filter((e) => !e.ok)) + (result.error ?? ""));
  });
});
