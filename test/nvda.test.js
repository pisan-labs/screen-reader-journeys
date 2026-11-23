// Real NVDA on Windows. Runs only where Guidepup's setup has installed NVDA (SRJ_NVDA=1), for
// example in .github/workflows/nvda.yml; skipped everywhere else.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadJourney, runJourney } from "../src/journey.js";
import { renderJourney } from "../src/report.js";
import { serve } from "./server.js";

const enabled = process.env.SRJ_NVDA === "1";
const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

describe("nvda mode", { skip: !enabled && "set SRJ_NVDA=1 where NVDA is installed" }, () => {
  let site;
  let result;
  before(async () => {
    site = await serve(fixtures);
    result = await runJourney(await loadJourney(`${fixtures}basic.journey.js`), { mode: "nvda", baseUrl: site.url });
    // Keep the transcript in the CI log, so a failure can be read.
    console.log(renderJourney(result));
  });
  after(() => site?.close());

  it("runs the journey with NVDA and hears the button and the status message", () => {
    assert.equal(result.status, "pass", `${result.error ?? ""} ${JSON.stringify(result.expectations)}`);
    const heard = result.steps.flatMap((s) => s.spoken).join(" / ");
    assert.match(heard, /Save/i);
    assert.match(heard, /Saved/i);
  });
});
