// End-to-end self-test: run the basic journey in both Linux modes and check the transcript and findings.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadJourney, runJourney } from "../src/journey.js";
import { renderJourney } from "../src/report.js";
import { serve } from "./server.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
let site;
let journey;

before(async () => {
  site = await serve(fixtures);
  journey = await loadJourney(`${fixtures}basic.journey.js`);
});
after(() => site.close());

const rules = (result) => result.findings.map((f) => f.rule).sort();

describe("walker mode", () => {
  let result;
  before(async () => {
    result = await runJourney(journey, { mode: "walker", baseUrl: site.url });
  });

  it("reaches Save, announces the status and passes its checks", () => {
    assert.equal(result.status, "pass", JSON.stringify(result.expectations));
    const heard = result.steps.flatMap((s) => s.spoken);
    assert.ok(heard.includes("Save, button"), heard.join(" / "));
    assert.ok(heard.includes("status: Saved."), heard.join(" / "));
  });

  it("reports the planted problems", () => {
    assert.deepEqual(
      [...new Set(rules(result))],
      ["focus-in-aria-hidden", "focus-indicator", "no-name", "no-role"],
      JSON.stringify(result.findings, null, 1)
    );
    const hidden = result.findings.find((f) => f.rule === "focus-in-aria-hidden");
    assert.match(hidden.element, /button#hidden/);
  });

  it("renders a Markdown report with the transcript", () => {
    const md = renderJourney(result);
    assert.match(md, /\| Tab \| Save, button \|/);
    assert.match(md, /`focus-in-aria-hidden`/);
  });
});

describe("virtual mode", () => {
  let result;
  before(async () => {
    result = await runJourney(journey, { mode: "virtual", baseUrl: site.url });
  });

  it("hears the button and the status message from the emulated screen reader", () => {
    assert.equal(result.status, "pass", JSON.stringify(result.expectations) + (result.error ?? ""));
    const heard = result.steps.flatMap((s) => s.spoken).join(" / ");
    assert.match(heard, /Save/);
    assert.match(heard, /Saved\./);
  });
});
