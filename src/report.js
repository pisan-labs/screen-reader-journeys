// Reports: a transcript of what was heard, the checks, and the findings. Markdown and JSON here;
// HTML, JUnit, SARIF and CSV in formats.js.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { slug } from "./slug.js";
import { compareResults, hasComparison, renderCompare, renderCompareHtml } from "./compare.js";
import { renderChecksCsv, renderFindingsCsv, renderJourneyHtml, renderJunit, renderSarif, renderSummaryHtml } from "./formats.js";

export { slug };

/** Report formats `writeReports` can write. */
export const FORMATS = ["md", "json", "html", "junit", "sarif", "csv"];
export const DEFAULT_FORMATS = ["md", "json", "html"];

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const ICON = { pass: "✅ pass", fail: "❌ fail", error: "⚠️ error" };

export function renderJourney(result) {
  const failed = result.expectations.filter((e) => !e.ok).length;
  const errors = result.findings.filter((f) => f.level === "error").length;
  const warnings = result.findings.filter((f) => f.level === "warning").length;
  const lines = [
    `# ${result.journey}`,
    "",
    result.description ? `${result.description}\n` : "",
    `- **Result:** ${ICON[result.status]}${result.error ? ` (${result.error})` : ""}`,
    `- **Mode:** ${result.modeLabel}${result.browser ? `, ${result.browser}` : ""}`,
    `- **Page:** ${result.url}`,
    `- **Checks:** ${result.expectations.length - failed} of ${result.expectations.length} passed`,
    `- **Findings:** ${errors} errors, ${warnings} warnings`,
    `- **Run:** ${result.startedAt}`,
    "",
    "## Checks",
    "",
    ...(result.expectations.length
      ? result.expectations.map((e) => `- ${e.ok ? "✅" : "❌"} ${e.text}${e.detail ? `: ${e.detail}` : ""} (step ${e.step})`)
      : ["None."]),
    "",
    "## Findings",
    "",
    ...(result.findings.length
      ? result.findings.map(
          (f) => `- **${f.level}** \`${f.rule}\`: ${f.message}${f.element ? ` At ${f.element}` : ""}${f.count > 1 ? ` (${f.count} times)` : ""}, first at step ${f.step}.`
        )
      : ["None."]),
    "",
    "## Transcript",
    "",
    "What a screen reader user would hear after each action. In walker mode this is the focused",
    "element's role, name and states plus live-region announcements; in virtual and voiceover modes",
    "it is the screen reader's own speech.",
    "",
    "| # | Action | Heard |",
    "|---|---|---|",
    ...result.steps.map((s) => `| ${s.n} | ${cell(s.action)} | ${cell(s.spoken.join(" / ") || "—")} |`),
    "",
  ];
  if (result.pageErrors.length) {
    lines.push("## Page errors", "", "Errors the site's own scripts threw during the journey.", "", ...result.pageErrors.map((e) => `- ${e}`), "");
  }
  if (result.toolErrors?.length) {
    lines.push(
      "## Tool errors",
      "",
      "Errors from code this tool injects (the emulated screen reader), not from the site. The",
      "transcript around them may be missing an announcement.",
      "",
      ...result.toolErrors.map((e) => `- ${e}`),
      ""
    );
  }
  return lines.filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}

export function renderSummary(results) {
  const rows = results.map((r) => {
    const failed = r.expectations.filter((e) => !e.ok).length;
    const errors = r.findings.filter((f) => f.level === "error").length;
    const warnings = r.findings.filter((f) => f.level === "warning").length;
    return `| ${cell(r.journey)} | ${r.mode} | ${ICON[r.status]} | ${r.expectations.length - failed}/${r.expectations.length} | ${errors} | ${warnings} | [report](${slug(r.journey)}.${r.mode}.md) |`;
  });
  return [
    "# Screen reader journeys",
    "",
    results[0] ? `Site: ${new URL(results[0].url).origin}` : "",
    "",
    "| Journey | Mode | Result | Checks | Errors | Warnings | |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    hasComparison(results) ? "The same journeys side by side, step by step: [compare.md](compare.md).\n" : "",
    "Findings are automatic and can be wrong; the transcripts are for a person to read. None of",
    "this replaces testing with a real screen reader and with people who use one.",
    "",
  ].join("\n");
}

/**
 * Write the chosen formats into `outDir`:
 *   md     <journey>.<mode>.md and summary.md
 *   json   <journey>.<mode>.json
 *   html   <journey>.<mode>.html and summary.html
 *   junit  junit.xml
 *   sarif  results.sarif
 *   csv    findings.csv and checks.csv
 * When a journey ran in more than one mode, md and html also write compare.md and compare.html.
 * Returns the paths written.
 */
export async function writeReports(results, outDir, { formats = DEFAULT_FORMATS } = {}) {
  const unknown = formats.filter((f) => !FORMATS.includes(f));
  if (unknown.length) throw new Error(`Unknown report format: ${unknown.join(", ")}. Formats: ${FORMATS.join(", ")}`);
  await mkdir(outDir, { recursive: true });
  const written = [];
  const write = async (name, content) => {
    const path = join(outDir, name);
    await writeFile(path, content);
    written.push(path);
  };
  for (const result of results) {
    const base = `${slug(result.journey)}.${result.mode}`;
    if (formats.includes("md")) await write(`${base}.md`, renderJourney(result));
    if (formats.includes("json")) await write(`${base}.json`, JSON.stringify(result, null, 2));
    if (formats.includes("html")) await write(`${base}.html`, renderJourneyHtml(result));
  }
  if (formats.includes("md")) await write("summary.md", renderSummary(results));
  if (formats.includes("html")) await write("summary.html", renderSummaryHtml(results));
  if (hasComparison(results)) {
    const comparison = compareResults(results);
    if (formats.includes("md")) await write("compare.md", renderCompare(comparison));
    if (formats.includes("html")) await write("compare.html", renderCompareHtml(comparison));
  }
  if (formats.includes("junit")) await write("junit.xml", renderJunit(results));
  if (formats.includes("sarif")) await write("results.sarif", renderSarif(results));
  if (formats.includes("csv")) {
    await write("findings.csv", renderFindingsCsv(results));
    await write("checks.csv", renderChecksCsv(results));
  }
  return written;
}
