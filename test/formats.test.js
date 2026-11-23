// Report formats, from a hand-made result. Page text is untrusted, so each format must escape it.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderChecksCsv, renderFindingsCsv, renderJourneyHtml, renderJunit, renderSarif, renderSummaryHtml } from "../src/formats.js";
import { writeReports } from "../src/report.js";

const hostile = `<img src=x onerror="alert(1)"> & "quotes"`;
const result = {
  journey: "Sample journey",
  description: "A journey with hostile page text.",
  file: "x.journey.js",
  mode: "walker",
  modeLabel: "Keyboard walker",
  url: "https://example.org/p/demo",
  startedAt: "2026-11-23T10:00:00.000Z",
  status: "fail",
  browser: "chromium 1",
  steps: [
    { n: 1, action: "Tab", focus: null, spoken: [`${hostile}, button`] },
    { n: 2, action: "Enter", focus: null, spoken: ["status: =HYPERLINK(\"http://evil\")"] },
  ],
  expectations: [
    { ok: true, text: "Reach button Save with Tab", detail: "1 presses", step: 1 },
    { ok: false, text: "Announced: Saved", detail: `heard: ${hostile}`, step: 2 },
  ],
  findings: [
    { level: "error", rule: "no-name", message: "Focus lands on an element with no accessible name.", element: `button (${hostile})`, step: 1, count: 2 },
    { level: "warning", rule: "focus-indicator", message: "No focus indicator found.", element: "div.x", step: 2, count: 1 },
  ],
  pageErrors: [hostile],
  toolErrors: [],
};

describe("HTML", () => {
  it("escapes page text and marks results in words, not only colour", () => {
    const html = renderJourneyHtml(result);
    assert.ok(!html.includes("<img"), "raw markup from the page must not appear");
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /✗ Failed: Announced: Saved/);
    assert.match(html, /<span class="status status-fail">Fail<\/span>/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<caption>Findings<\/caption>/);
    assert.match(html, /<a class="skip" href="#main">/);
  });

  it("links each journey from the summary", () => {
    const html = renderSummaryHtml([result]);
    assert.match(html, /href="sample-journey\.walker\.html"/);
    assert.match(html, /<th scope="row">/);
  });
});

describe("JUnit", () => {
  it("has a test case per check and finding, with failures for failed checks and error findings", () => {
    const xml = renderJunit([result]);
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<testsuite name="Sample journey \[walker\]" tests="4" failures="2" errors="0"/);
    assert.equal((xml.match(/<testcase /g) ?? []).length, 4);
    assert.equal((xml.match(/<failure /g) ?? []).length, 2);
    assert.ok(!xml.includes("<img"), "page text must be escaped");
  });

  it("reports a journey that could not run as an error", () => {
    const xml = renderJunit([{ ...result, status: "error", error: "net::ERR_NAME_NOT_RESOLVED", expectations: [], findings: [] }]);
    assert.match(xml, /errors="1"/);
    assert.match(xml, /<error message="net::ERR_NAME_NOT_RESOLVED"\/>/);
  });
});

describe("SARIF", () => {
  it("is SARIF 2.1.0 with a rule per finding type and results for findings and failed checks", () => {
    const sarif = JSON.parse(renderSarif([result]));
    assert.equal(sarif.version, "2.1.0");
    const run = sarif.runs[0];
    assert.equal(run.tool.driver.name, "screen-reader-journeys");
    assert.deepEqual(run.tool.driver.rules.map((r) => r.id).sort(), ["check-failed", "focus-indicator", "no-name"]);
    assert.equal(run.results.length, 3);
    assert.equal(run.results.find((r) => r.ruleId === "focus-indicator").level, "warning");
    assert.equal(run.results[0].locations[0].physicalLocation.artifactLocation.uri, "https://example.org/p/demo");
  });
});

describe("CSV", () => {
  it("quotes cells and defuses spreadsheet formulas from page text", () => {
    const findings = renderFindingsCsv([result]);
    const lines = findings.trim().split("\r\n");
    assert.equal(lines[0], "journey,mode,level,rule,message,element,times,first_step,url");
    assert.equal(lines.length, 3);
    assert.match(findings, /"button \(<img src=x onerror=""alert\(1\)""> & ""quotes""\)"/);
    const checks = renderChecksCsv([{ ...result, expectations: [{ ok: false, text: "=cmd()", detail: "+1", step: 1 }] }]);
    assert.match(checks, /'=cmd\(\)/);
    assert.match(checks, /'\+1/);
  });
});

describe("writeReports", () => {
  it("writes every chosen format and refuses unknown ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "srj-"));
    await writeReports([result], dir, { formats: ["md", "json", "html", "junit", "sarif", "csv"] });
    const files = (await readdir(dir)).sort();
    assert.deepEqual(files, [
      "checks.csv",
      "findings.csv",
      "junit.xml",
      "results.sarif",
      "sample-journey.walker.html",
      "sample-journey.walker.json",
      "sample-journey.walker.md",
      "summary.html",
      "summary.md",
    ]);
    assert.match(await readFile(join(dir, "summary.md"), "utf8"), /Sample journey/);
    await assert.rejects(writeReports([result], dir, { formats: ["pdf"] }), /Unknown report format: pdf/);
  });
});

describe("withoutKeyEcho", () => {
  it("drops a screen reader's echo of the pressed key, alone or joined to the speech", async () => {
    const { withoutKeyEcho } = await import("../src/drivers.js");
    assert.deepEqual(withoutKeyEcho(["tab. main content. Save. button"], "Tab"), ["main content. Save. button"]);
    assert.deepEqual(withoutKeyEcho(["return. Saved."], "Enter"), ["Saved."]);
    assert.deepEqual(withoutKeyEcho(["tab", "Save, button"], "Tab"), ["Save, button"]);
    assert.deepEqual(withoutKeyEcho(["shift tab", "Skip, link"], "Shift+Tab"), ["Skip, link"]);
    // Speech that only starts with the same letters is kept.
    assert.deepEqual(withoutKeyEcho(["Tabs, list", "main landmark, Save, button"], "Tab"), ["Tabs, list", "main landmark, Save, button"]);
  });
});
