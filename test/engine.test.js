// End-to-end self-test: run the basic journey in both Linux modes and check the transcript and findings.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadJourney, runJourney } from "../src/journey.js";
import { renderJourney, renderSummary } from "../src/report.js";
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

  it("says nothing about the network when the page went quiet", () => {
    assert.ok(!result.steps.some((s) => /network was still busy/.test(s.action)), result.steps.map((s) => s.action).join(" | "));
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
  // an image that never arrives, so its load event never fires. /late.html fetches four more
  // links after load, from /api?ms=N, which answers N ms later. /held.html, once loaded, asks
  // for /hold, and the page is then closed under the journey (`held`).
  let server;
  let base;
  let held = null;
  const still = (s) => `the network was still busy ${s} s after the page loaded: the page may still have been loading, and the walk may be incomplete`;
  before(async () => {
    const { createServer } = await import("node:http");
    const late = '<!doctype html><title>Late</title><h1>Late</h1><a href="#one">One</a><div id="more"></div><script>fetch("/api" + location.search).then((r) => r.text()).then((t) => (document.getElementById("more").innerHTML = t))</script>';
    const pages = {
      "/open.html": '<!doctype html><title>Open</title><button>One</button> <button>Two</button><script>fetch("/forever")</script>',
      "/stuck.html": '<!doctype html><title>Stuck</title><button>One</button><img alt="" src="/forever">',
      "/late.html": late,
      "/held.html": '<!doctype html><title>Held</title><button>One</button><script>addEventListener("load", () => fetch("/hold"))</script>',
    };
    server = createServer((req, res) => {
      const path = req.url.split("?")[0];
      if (path === "/api") {
        const ms = Number(new URL(req.url, "http://x").searchParams.get("ms"));
        return setTimeout(() => res.writeHead(200, { "Content-Type": "text/html" }).end('<a href="#a">Two</a> <a href="#b">Three</a> <a href="#c">Four</a> <a href="#d">Five</a>'), ms);
      }
      // Some time after load, so the wait for quiet has begun; the request itself is never answered.
      if (path === "/hold") return setTimeout(() => held?.close(), 300);
      if (path === "/forever") return; // never answered
      if (!pages[path]) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(pages[path]);
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
    assert.equal(result.steps[0].action, `note: ${still(1)}`, "and says the page may not have finished (R22.1-1)");
    assert.equal(result.stillLoading, still(1));
  });

  it("waits for content that comes after load, while the network is busy (R22.1-1)", async () => {
    const journey = { name: "Late", start: "/late.html?ms=300", run: (sr) => sr.walkTabOrder() };
    const result = await runJourney(journey, { mode: "walker", baseUrl: base, idleWaitMs: 10_000 });
    assert.equal(result.status, "pass", result.error);
    const tabs = result.steps.filter((s) => s.action === "Tab").map((s) => s.focus?.name);
    assert.deepEqual(tabs.slice(0, 5), ["One", "Two", "Three", "Four", "Five"], "the links that came later were walked too");
    assert.ok(!result.steps.some((s) => /network was still busy/.test(s.action)));
    assert.equal(result.stillLoading, undefined);
  });

  it("waits out content that comes 8 s after load, with the default wait (R22.1-1)", async () => {
    const journey = { name: "Late", start: "/late.html?ms=8000", run: (sr) => sr.walkTabOrder() };
    const result = await runJourney(journey, { mode: "walker", baseUrl: base });
    const tabs = result.steps.filter((s) => s.action === "Tab").map((s) => s.focus?.name);
    assert.deepEqual(tabs.slice(0, 5), ["One", "Two", "Three", "Four", "Five"]);
    assert.equal(result.stillLoading, undefined);
  });

  it("says so when the content may still have been coming at the end of the wait (R22.1-1)", async () => {
    const journey = { name: "Late", start: "/late.html?ms=3000", run: (sr) => sr.walkTabOrder() };
    const result = await runJourney(journey, { mode: "walker", baseUrl: base, idleWaitMs: 300 });
    assert.equal(result.steps[0].action, `note: ${still(0.3)}`);
    // The journey's report and summary.md say it at the top, not only in the transcript.
    assert.ok(renderJourney(result).includes(`- **Note:** ${still(0.3)}.`), renderJourney(result).slice(0, 600));
    const summary = renderSummary([result]);
    assert.ok(summary.includes(`- Late, walker: ${still(0.3)}.`), summary);
  });

  it("fails where the page closes during the wait for quiet, not later (R22.1-3)", async () => {
    const journey = { name: "Held", start: "/held.html", setup: (page) => (held = page), run: (sr) => sr.walkTabOrder() };
    const result = await runJourney(journey, { mode: "walker", baseUrl: base, idleWaitMs: 10_000 });
    held = null;
    assert.equal(result.status, "error");
    assert.match(result.error, /^page\.waitForLoadState: /);
  });

  it("still gives up on a page whose load event never fires", async () => {
    const journey = { name: "Stuck", start: "/stuck.html", run: (sr) => sr.walkTabOrder() };
    const result = await runJourney(journey, { mode: "walker", baseUrl: base, loadTimeoutMs: 2000 });
    assert.equal(result.status, "error");
    assert.match(result.error, /page\.goto: Timeout 2000ms exceeded/);
  });
});
