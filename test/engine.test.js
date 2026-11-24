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
  const stepsSeen = [];
  before(async () => {
    result = await runJourney(journey, { mode: "walker", baseUrl: site.url, onStep: (step) => stepsSeen.push(step.n) });
  });

  it("tells onStep of each step as it is recorded (the hosted service shows progress with it)", () => {
    assert.deepEqual(stepsSeen, result.steps.map((s) => s.n));
    assert.ok(stepsSeen.length > 0);
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

describe("focus inside an open shadow root", () => {
  for (const mode of ["walker", "virtual"]) {
    it(`names the focused element, not its shadow host (${mode})`, async () => {
      const result = await runJourney(await loadJourney(`${fixtures}shadow.journey.js`), { mode, baseUrl: site.url });
      const stops = result.steps.filter((s) => s.focus).map((s) => s.focus.selector);
      assert.ok(stops.includes("a"), JSON.stringify(stops));
      assert.ok(!stops.includes("site-footer"), `the shadow host was reported as the focus: ${JSON.stringify(stops)}`);
      if (mode === "walker") assert.ok(result.steps.flatMap((s) => s.spoken).includes("Send an idea, link"), JSON.stringify(result.steps.map((s) => s.spoken)));
      const hidden = result.findings.filter((f) => f.rule === "focus-in-aria-hidden");
      assert.equal(hidden.length, 1, "the link under aria-hidden inside the shadow root is found");
      assert.ok(!result.findings.some((f) => f.rule === "no-name" && !/hidden/.test(f.element ?? "")), JSON.stringify(result.findings));
    });
  }
});

describe("opening the page", () => {
  // /open.html keeps a request open for ever (as an ad or analytics script can); /stuck.html has
  // an image that never arrives, so its load event never fires.
  let server;
  let base;
  before(async () => {
    const { createServer } = await import("node:http");
    const pages = {
      "/open.html": '<!doctype html><title>Open</title><button>One</button> <button>Two</button><script>fetch("/forever")</script>',
      "/stuck.html": '<!doctype html><title>Stuck</title><button>One</button><img alt="" src="/forever">',
    };
    server = createServer((req, res) => {
      if (req.url === "/forever") return; // never answered
      if (!pages[req.url]) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(pages[req.url]);
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}/`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("tests a page that keeps a request open, once its load event has fired", async () => {
    const journey = { name: "Open request", start: "/open.html", run: (sr) => sr.walkTabOrder() };
    const result = await runJourney(journey, { mode: "walker", baseUrl: base, idleWaitMs: 1000 });
    assert.equal(result.status, "pass", result.error);
    assert.ok(result.steps.length >= 2, "it walked the page");
  });

  it("still gives up on a page whose load event never fires", async () => {
    const journey = { name: "Stuck", start: "/stuck.html", run: (sr) => sr.walkTabOrder() };
    const result = await runJourney(journey, { mode: "walker", baseUrl: base, loadTimeoutMs: 2000 });
    assert.equal(result.status, "error");
    assert.match(result.error, /page\.goto: Timeout 2000ms exceeded/);
  });
});
