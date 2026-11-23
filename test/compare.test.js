// The comparison report: lining up runs of the same journey, from hand-made results and from real
// walker and virtual runs of the fixture page.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareResults, hasComparison, loadResults, renderCompare, renderCompareHtml } from "../src/compare.js";
import { loadJourney, runJourney } from "../src/journey.js";
import { writeReports } from "../src/report.js";
import { serve } from "./server.js";

const run = (mode, steps, extra = {}) => ({
  journey: "Sample",
  description: "",
  mode,
  modeLabel: mode,
  url: "https://example.org/p/demo",
  status: "pass",
  steps: steps.map(([action, spoken = [], focus = null], i) => ({ n: i + 1, action, spoken, focus })),
  expectations: [{ ok: true, text: "Reach Save", step: 1 }],
  findings: [],
  pageErrors: [],
  toolErrors: [],
  ...extra,
});

const save = { role: "button", name: "Save" };
const div = { role: "generic", name: "Clickable div" };

describe("compareResults", () => {
  const walker = run("walker", [
    ["Tab", ["Save, button"], save],
    ["Enter", ["status: Saved."], save],
    ["Tab", ["Clickable div, generic"], div],
    ["note: Tab order: 2 stops"],
    ["note: Reading line by line needs the virtual or voiceover mode."],
  ]);
  const nvda = run("nvda", [
    ["Tab", ["Save, button"], save],
    ["Enter", ["Saved."], save],
    ["Tab", [], div],
    ["note: Tab order: 2 stops"],
    ["read next", ["heading level 1, Demo"]],
    ["read next", ["Save, button"]],
    ["read next", ["end of document"]],
  ]);
  const virtual = run("virtual", [["Tab", ["button, Save"], { role: "button", name: "Other" }]], { status: "error", error: "stopped" });

  it("lines up the same steps, orders the columns by mode and flags the differences", () => {
    const { journeys } = compareResults([nvda, walker, virtual]);
    assert.equal(journeys.length, 1);
    const [j] = journeys;
    assert.deepEqual(j.columns.map((c) => c.label), ["walker", "virtual", "nvda"]);
    assert.deepEqual(j.rows.map((r) => r.action), ["Tab", "Enter", "Tab", "note", "read the page"]);
    const [first, enter, silentTab, note, read] = j.rows;
    assert.deepEqual(first.differences, ["focus differs"]);
    assert.deepEqual(enter.differences, ["missing in virtual"]);
    assert.deepEqual(enter.cells.map((c) => c.text.join()), ["status: Saved.", "", "Saved."]);
    assert.deepEqual(silentTab.differences, ["silent in nvda", "missing in virtual"]);
    assert.equal(note.cells[2].text[0], "Tab order: 2 stops");
    // Reading line by line: one row, with the walker's "not supported" note beside NVDA's speech.
    assert.equal(read.cells[0].state, "note");
    assert.match(read.cells[0].text[0], /line by line/);
    assert.deepEqual(read.cells[2].text, ["heading level 1, Demo", "Save, button", "end of document"]);
    assert.equal(j.differing, 5);
  });

  it("compares two sites, naming each column by mode and site", () => {
    const main = run("walker", [["Tab", ["Save, button"], save]], { url: "https://main.example.org/p" });
    const preview = run("walker", [["Tab", ["button"], { role: "button", name: "" }]], { url: "https://pr-1.example.org/p" });
    const [j] = compareResults([main, preview]).journeys;
    assert.deepEqual(j.columns.map((c) => c.label), ["walker (main.example.org)", "walker (pr-1.example.org)"]);
    assert.deepEqual(j.rows[0].differences, ["focus differs"]);
  });

  it("skips journeys that ran once", () => {
    assert.equal(hasComparison([walker]), false);
    assert.deepEqual(compareResults([walker]).journeys, []);
    assert.match(renderCompare(compareResults([walker])), /nothing to compare/);
  });
});

describe("rendering", () => {
  const hostile = `<img src=x onerror="alert(1)"> | pipe`;
  const results = [run("walker", [["Tab", [hostile], save]]), run("virtual", [["Tab", [hostile], save]])];

  it("escapes page text in Markdown and HTML", () => {
    const comparison = compareResults(results);
    const md = renderCompare(comparison);
    assert.match(md, /\\\| pipe/);
    assert.ok(!md.split("\n").some((line) => line.startsWith("| 1 |") && line.split(/(?<!\\)\|/).length !== 7), md);
    const html = renderCompareHtml(comparison);
    assert.ok(!html.includes("<img"), "raw markup from the page must not appear");
    assert.match(html, /&lt;img src=x/);
    assert.match(html, /<th scope="row">1\. Tab<\/th>/);
    assert.match(html, /role="region" aria-labelledby="steps-0" tabindex="0"/);
  });

  it("clips very long speech and points to the mode's report", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const comparison = compareResults([run("walker", [["read next", long]]), run("virtual", [["read next", long]])]);
    assert.match(renderCompare(comparison), /… 10 more in the mode's report/);
  });
});

describe("loading and writing", () => {
  it("reads results from folders, ignores other JSON, and srj compare writes the report", async () => {
    const dir = await mkdtemp(join(tmpdir(), "srj-compare-"));
    await writeReports([run("walker", [["Tab", ["Save, button"], save]])], join(dir, "a"), { formats: ["json"] });
    await writeReports([run("orca", [["Tab", ["Save. button"], save]])], join(dir, "b"), { formats: ["json"] });
    await writeFile(join(dir, "b", "other.json"), JSON.stringify({ name: "not a result" }));
    await writeFile(join(dir, "b", "broken.json"), "{");
    const results = await loadResults([dir]);
    assert.deepEqual(results.map((r) => r.mode).sort(), ["orca", "walker"]);

    const out = join(dir, "out");
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "compare", join(dir, "a"), join(dir, "b"), "--out", out, "--format", "md,json"]);
    assert.match(stdout, /2 results, 1 journeys compared/);
    assert.match(await readFile(join(out, "compare.md"), "utf8"), /\| 1 \| Tab \| Save, button \| Save\. button \|/);
    const json = JSON.parse(await readFile(join(out, "compare.json"), "utf8"));
    assert.equal(json.journeys.length, 1);
    // Links lead back to each run's own reports, in their own folders.
    assert.deepEqual(json.journeys[0].columns.map((c) => c.report), ["../a/sample.walker", "../b/sample.orca"]);
  });

  it("srj compare refuses formats it cannot write", async () => {
    const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
    await assert.rejects(promisify(execFile)(process.execPath, [cli, "compare", "--format", "sarif"]), (error) => error.code === 2);
  });
});

describe("real runs of the fixture page", () => {
  const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
  let site;
  let comparison;
  let written;
  before(async () => {
    site = await serve(fixtures);
    const journey = await loadJourney(`${fixtures}basic.journey.js`);
    const results = [];
    for (const mode of ["walker", "virtual"]) results.push(await runJourney(journey, { mode, baseUrl: site.url }));
    comparison = compareResults(results);
    written = await writeReports(results, await mkdtemp(join(tmpdir(), "srj-compare-run-")), { formats: ["md", "html"] });
  });
  after(() => site?.close());

  it("lines up every step of the two modes", () => {
    const [j] = comparison.journeys;
    assert.ok(j.rows.every((r) => !r.differences.some((d) => d.startsWith("missing"))), renderCompare(comparison));
    const save = j.rows.find((r) => r.cells[0].text.includes("Save, button"));
    assert.ok(save, renderCompare(comparison));
    assert.equal(save.cells[1].state, "heard");
  });

  it("shows that the emulated screen reader is silent on the aria-hidden button", () => {
    const [j] = comparison.journeys;
    const hidden = j.rows.find((r) => r.cells[0].text.some((t) => /Hidden button/.test(t)));
    assert.ok(hidden, renderCompare(comparison));
    assert.deepEqual(hidden.differences, ["silent in virtual"]);
  });

  it("writes compare.md and compare.html next to the other reports, linked from the summaries", async () => {
    assert.ok(written.some((p) => p.endsWith("compare.md")) && written.some((p) => p.endsWith("compare.html")));
    const summary = await readFile(written.find((p) => p.endsWith("summary.md")), "utf8");
    assert.match(summary, /\[compare\.md\]\(compare\.md\)/);
    const summaryHtml = await readFile(written.find((p) => p.endsWith("summary.html")), "utf8");
    assert.match(summaryHtml, /href="compare\.html"/);
  });
});
