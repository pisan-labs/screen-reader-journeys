// Markdown and JSON reports: a transcript of what was heard, the checks, and the findings.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const ICON = { pass: "✅ pass", fail: "❌ fail", error: "⚠️ error" };

export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "journey";
}

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
    "Findings are automatic and can be wrong; the transcripts are for a person to read. None of",
    "this replaces testing with a real screen reader and with people who use one.",
    "",
  ].join("\n");
}

export async function writeReports(results, outDir) {
  await mkdir(outDir, { recursive: true });
  for (const result of results) {
    const base = join(outDir, `${slug(result.journey)}.${result.mode}`);
    await writeFile(`${base}.md`, renderJourney(result));
    await writeFile(`${base}.json`, JSON.stringify(result, null, 2));
  }
  await writeFile(join(outDir, "summary.md"), renderSummary(results));
}
