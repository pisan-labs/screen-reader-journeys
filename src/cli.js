#!/usr/bin/env node
// srj: run screen reader journeys against a site and write transcripts.
//
//   srj run [paths...] --base-url URL [--mode walker,virtual] [--out reports] [--headed] [--fail-on error]
//   srj list [paths...]
//   srj compare [reports...] [--out compare] [--format md,html,json]
//
// Paths are journey files (*.journey.js) or folders searched for them; the default is targets/.

import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { loadJourney, runJourney } from "./journey.js";
import { COMPARE_FORMATS, compareResults, loadResults, renderCompare, renderCompareHtml } from "./compare.js";
import { DEFAULT_FORMATS, FORMATS, writeReports } from "./report.js";

const USAGE = `Usage:
  srj run [paths...] --base-url URL [--mode walker,virtual] [--format md,json,html] [--out reports] [--headed] [--fail-on error|warning|none]
  srj list [paths...]
  srj compare [reports...] [--out compare] [--format md,html,json]

compare reads the JSON results of earlier runs (folders or files; for example the reports from
different screen readers, or from two sites) and lines up what each run heard, step by step.

Formats: ${FORMATS.join(", ")} (default ${DEFAULT_FORMATS.join(",")}).
Modes: walker (accessibility tree), virtual (emulated screen reader), voiceover (macOS only), orca (Linux) and nvda (Windows), after Guidepup's setup.`;

async function findJourneys(paths) {
  const files = [];
  for (const path of paths.length ? paths : ["targets"]) {
    const full = resolve(path);
    if ((await stat(full)).isDirectory()) {
      for (const entry of await readdir(full, { recursive: true })) {
        if (entry.endsWith(".journey.js")) files.push(join(full, entry));
      }
    } else files.push(full);
  }
  return files.sort();
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "base-url": { type: "string" },
      mode: { type: "string", default: "walker,virtual" },
      out: { type: "string" },
      format: { type: "string" },
      headed: { type: "boolean", default: false },
      "fail-on": { type: "string", default: "none" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...paths] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return 0;
  }
  if (command === "compare") return compare(paths, values);
  values.out ??= "reports";
  values.format ??= DEFAULT_FORMATS.join(",");
  const journeys = await Promise.all((await findJourneys(paths)).map(loadJourney));
  if (command === "list") {
    for (const j of journeys) console.log(`${relative(process.cwd(), j.file)}  ${j.name}`);
    return 0;
  }
  if (command !== "run") {
    console.error(USAGE);
    return 2;
  }
  if (!values["base-url"]) {
    console.error("--base-url is required, e.g. a pull request's preview address.");
    return 2;
  }
  const modes = values.mode.split(",").map((m) => m.trim()).filter(Boolean);
  const results = [];
  for (const journey of journeys) {
    for (const mode of modes) {
      process.stdout.write(`${journey.name} [${mode}] … `);
      const result = await runJourney(journey, { mode, baseUrl: values["base-url"], headed: values.headed });
      const errors = result.findings.filter((f) => f.level === "error").length;
      console.log(`${result.status}${result.error ? ` (${result.error})` : ""}, ${errors} errors, ${result.findings.length - errors} warnings`);
      results.push(result);
    }
  }
  const formats = values.format.split(",").map((f) => f.trim()).filter(Boolean);
  const written = await writeReports(results, values.out, { formats });
  console.log(`Reports (${formats.join(", ")}): ${written.length} files in ${relative(process.cwd(), resolve(values.out)) || "."}`);

  const failOn = values["fail-on"];
  const findingFails = results.some((r) =>
    r.findings.some((f) => (failOn === "warning" ? true : failOn === "error" ? f.level === "error" : false))
  );
  return results.some((r) => r.status !== "pass") || findingFails ? 1 : 0;
}

async function compare(paths, values) {
  const formats = (values.format ?? "md,html").split(",").map((f) => f.trim()).filter(Boolean);
  const unknown = formats.filter((f) => !COMPARE_FORMATS.includes(f));
  if (unknown.length) {
    console.error(`compare writes ${COMPARE_FORMATS.join(", ")}, not ${unknown.join(", ")}.`);
    return 2;
  }
  const results = await loadResults(paths.length ? paths : ["reports"]);
  const out = values.out ?? "compare";
  // Link each run to its own reports, which sit beside its JSON file.
  for (const result of results) result.reportPath = relative(resolve(out), resolve(result.source.replace(/\.json$/, ""))).split(sep).join("/");
  const comparison = compareResults(results);
  await mkdir(out, { recursive: true });
  const render = { md: renderCompare, html: renderCompareHtml, json: (c) => JSON.stringify(c, null, 2) };
  for (const format of formats) await writeFile(join(out, `compare.${format}`), render[format](comparison));
  const differing = comparison.journeys.reduce((sum, j) => sum + j.differing, 0);
  console.log(
    `${results.length} results, ${comparison.journeys.length} journeys compared, ${differing} differing steps. ` +
      `Wrote compare.{${formats.join(",")}} in ${relative(process.cwd(), resolve(out)) || "."}`
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error.message);
    process.exit(2);
  }
);
