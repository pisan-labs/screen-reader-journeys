// Report formats besides Markdown and JSON:
//   html   a self-contained, accessible page per journey and mode, plus summary.html
//   junit  junit.xml, for CI systems that show test results (GitHub, GitLab, Jenkins…)
//   sarif  results.sarif (SARIF 2.1.0), for code scanning and static-analysis viewers
//   csv    findings.csv and checks.csv, for spreadsheets
//
// Transcripts contain text from the site under test, so everything is escaped.

import { slug } from "./slug.js";

const hasComparison = (results) => {
  const names = results.map((r) => r.journey);
  return names.some((name, i) => names.indexOf(name) !== i);
};

const TOOL = { name: "screen-reader-journeys", version: "0.1.0", uri: "https://github.com/pisan-labs/screen-reader-journeys" };

const counts = (r) => ({
  failed: r.expectations.filter((e) => !e.ok).length,
  errors: r.findings.filter((f) => f.level === "error").length,
  warnings: r.findings.filter((f) => f.level === "warning").length,
});

// ---------- HTML ----------

export const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const STATUS_TEXT = { pass: "Pass", fail: "Fail", error: "Error" };

const STYLE = `
:root { --bg: #fff; --fg: #1b1b1b; --muted: #555; --border: #ccc; --pass: #1b6b2b; --fail: #a3001b; --focus: #184c45; --row: #f4f4f4; }
@media (prefers-color-scheme: dark) { :root { --bg: #141414; --fg: #eee; --muted: #bbb; --border: #555; --pass: #7ddc8f; --fail: #ff8a9b; --focus: #8fd3c8; --row: #1f1f1f; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 1100px; margin: 0 auto; }
a { color: inherit; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.skip { position: absolute; left: -9999px; }
.skip:focus { left: 16px; top: 8px; background: var(--bg); padding: 4px 8px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
.status { font-weight: 700; }
.status-pass { color: var(--pass); }
.status-fail, .status-error { color: var(--fail); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 24px; }
caption { text-align: left; font-weight: 700; padding: 4px 0; }
th, td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; vertical-align: top; }
tbody tr:nth-child(even) { background: var(--row); }
ul.checks { padding-left: 0; list-style: none; }
ul.checks li { margin: 4px 0; }
.note { color: var(--muted); }
`;

/** A self-contained, accessible HTML page in the reports' style. */
export function htmlPage(title, body, extraStyle = "") {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}${extraStyle}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the report</a>
<main id="main">
${body}
</main>
</body>
</html>
`;
}

export const statusBadge = (status) => `<span class="status status-${status}">${STATUS_TEXT[status] ?? escapeHtml(status)}</span>`;

export function renderJourneyHtml(r) {
  const c = counts(r);
  const checks = r.expectations.length
    ? `<ul class="checks">${r.expectations
        .map((e) => `<li>${e.ok ? "✓ Passed" : "✗ Failed"}: ${escapeHtml(e.text)}${e.detail ? ` (${escapeHtml(e.detail)})` : ""}, step ${e.step}</li>`)
        .join("")}</ul>`
    : "<p>None.</p>";
  const findings = r.findings.length
    ? `<div class="table-wrap"><table><caption>Findings</caption><thead><tr><th scope="col">Level</th><th scope="col">Rule</th><th scope="col">Problem</th><th scope="col">Where</th><th scope="col">Times</th><th scope="col">First step</th></tr></thead><tbody>${r.findings
        .map(
          (f) =>
            `<tr><td>${escapeHtml(f.level)}</td><td><code>${escapeHtml(f.rule)}</code></td><td>${escapeHtml(f.message)}</td><td>${escapeHtml(f.element ?? "")}</td><td>${f.count}</td><td>${f.step}</td></tr>`
        )
        .join("")}</tbody></table></div>`
    : "<p>None.</p>";
  const transcript = `<div class="table-wrap"><table><caption>Transcript: what a screen reader user would hear after each action</caption><thead><tr><th scope="col">Step</th><th scope="col">Action</th><th scope="col">Heard</th></tr></thead><tbody>${r.steps
    .map((s) => `<tr><td>${s.n}</td><td>${escapeHtml(s.action)}</td><td>${s.spoken.length ? s.spoken.map(escapeHtml).join("<br>") : "—"}</td></tr>`)
    .join("")}</tbody></table></div>`;
  const errorsList = (title, intro, list) =>
    list?.length ? `<h2>${title}</h2><p>${intro}</p><ul>${list.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>` : "";
  return htmlPage(
    `${r.journey} (${r.mode})`,
    `<h1>${escapeHtml(r.journey)}</h1>
${r.description ? `<p>${escapeHtml(r.description)}</p>` : ""}
<dl>
<dt>Result</dt><dd>${statusBadge(r.status)}${r.error ? ` (${escapeHtml(r.error)})` : ""}</dd>
<dt>Mode</dt><dd>${escapeHtml(r.modeLabel)}${r.browser ? `, ${escapeHtml(r.browser)}` : ""}</dd>
<dt>Page</dt><dd><a href="${escapeHtml(r.url)}">${escapeHtml(r.url)}</a></dd>
<dt>Checks</dt><dd>${r.expectations.length - c.failed} of ${r.expectations.length} passed</dd>
<dt>Findings</dt><dd>${c.errors} errors, ${c.warnings} warnings</dd>
<dt>Run</dt><dd>${escapeHtml(r.startedAt)}</dd>
</dl>
<h2>Checks</h2>
${checks}
<h2>Findings</h2>
${findings}
<h2>Transcript</h2>
<p class="note">In walker mode: the focused element's role, name and states, plus live-region announcements. In the other modes: the screen reader's own speech.</p>
${transcript}
${errorsList("Page errors", "Errors the site's own scripts threw during the journey.", r.pageErrors)}
${errorsList("Tool errors", "Errors from code this tool injects (the emulated screen reader), not from the site.", r.toolErrors)}`
  );
}

export function renderSummaryHtml(results) {
  const rows = results
    .map((r) => {
      const c = counts(r);
      return `<tr><th scope="row"><a href="${escapeHtml(`${slug(r.journey)}.${r.mode}.html`)}">${escapeHtml(r.journey)}</a></th><td>${escapeHtml(r.mode)}</td><td>${statusBadge(r.status)}</td><td>${r.expectations.length - c.failed} of ${r.expectations.length}</td><td>${c.errors}</td><td>${c.warnings}</td></tr>`;
    })
    .join("");
  return htmlPage(
    "Screen reader journeys",
    `<h1>Screen reader journeys</h1>
${results[0] ? `<p>Site: ${escapeHtml(new URL(results[0].url).origin)}</p>` : ""}
<div class="table-wrap"><table><caption>Results by journey and mode</caption><thead><tr><th scope="col">Journey</th><th scope="col">Mode</th><th scope="col">Result</th><th scope="col">Checks passed</th><th scope="col">Errors</th><th scope="col">Warnings</th></tr></thead><tbody>${rows}</tbody></table></div>
${hasComparison(results) ? '<p><a href="compare.html">Compare the modes side by side, step by step</a>.</p>' : ""}
<p class="note">Findings are automatic and can be wrong; the transcripts are for a person to read. None of this replaces testing with a real screen reader and with people who use one.</p>`
  );
}

// ---------- JUnit XML ----------

const escapeXml = (value) =>
  String(value ?? "")
    // Characters XML 1.0 does not allow at all.
    // eslint-disable-next-line no-control-regex -- the allowed control characters are the point
    .replace(/[^\x09\x0A\x0D\x20-퟿-�]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * One <testsuite> per journey and mode. Each check is a test case; each error finding is a
 * failing test case and each warning a passing one with the warning as output, so CI shows
 * findings next to checks. A journey that could not run is one test case with an <error>.
 */
export function renderJunit(results) {
  const suites = results.map((r) => {
    const name = `${r.journey} [${r.mode}]`;
    const cases = [];
    for (const e of r.expectations) {
      cases.push(
        `    <testcase classname="${escapeXml(name)}" name="${escapeXml(`check: ${e.text}`)}">${e.ok ? "" : `<failure message="${escapeXml(e.detail ?? "failed")}">${escapeXml(`${e.text}: ${e.detail ?? ""} (step ${e.step})`)}</failure>`}</testcase>`
      );
    }
    for (const f of r.findings) {
      const label = `${f.level} ${f.rule}${f.element ? ` at ${f.element}` : ""}`;
      cases.push(
        f.level === "error"
          ? `    <testcase classname="${escapeXml(name)}" name="${escapeXml(`finding: ${label}`)}"><failure message="${escapeXml(f.message)}">${escapeXml(`${f.message} (${f.count} times, first at step ${f.step})`)}</failure></testcase>`
          : `    <testcase classname="${escapeXml(name)}" name="${escapeXml(`finding: ${label}`)}"><system-out>${escapeXml(f.message)}</system-out></testcase>`
      );
    }
    if (r.status === "error") {
      cases.push(`    <testcase classname="${escapeXml(name)}" name="run"><error message="${escapeXml(r.error ?? "error")}"/></testcase>`);
    }
    const failures = r.expectations.filter((e) => !e.ok).length + r.findings.filter((f) => f.level === "error").length;
    return `  <testsuite name="${escapeXml(name)}" tests="${cases.length}" failures="${failures}" errors="${r.status === "error" ? 1 : 0}" timestamp="${escapeXml(r.startedAt)}">
    <properties><property name="url" value="${escapeXml(r.url)}"/><property name="mode" value="${escapeXml(r.modeLabel)}"/></properties>
${cases.join("\n")}
  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="screen-reader-journeys">\n${suites.join("\n")}\n</testsuites>\n`;
}

// ---------- SARIF 2.1.0 ----------

const RULES = {
  "focus-in-aria-hidden": "Keyboard focus lands inside aria-hidden content, so screen readers cannot announce it.",
  "no-name": "A focusable element has no accessible name.",
  "keyboard-trap": "Tab does not move focus away from an element.",
  "no-role": "A focusable element has no role.",
  "focus-indicator": "No focus indicator found (outline or box-shadow); check by eye.",
  "invisible-focus": "The focused element has no size on screen.",
  "long-tab-order": "The Tab order did not come back round within the limit.",
  "check-failed": "A journey's check failed: something a user should be able to do or hear did not happen.",
  "journey-error": "The journey could not run.",
};

/**
 * SARIF for code-scanning style viewers. Results point at the page URL (there is no source
 * file for a rendered page) with the element in a logical location. GitHub code scanning needs
 * repository file locations to show an alert in the code view, so use this with viewers that
 * accept URLs, or keep it as a machine-readable record.
 */
export function renderSarif(results) {
  const used = new Set();
  const sarifResults = [];
  for (const r of results) {
    const location = (element, step) => [
      {
        physicalLocation: { artifactLocation: { uri: r.url } },
        logicalLocations: element ? [{ name: element, kind: "element" }] : undefined,
        message: { text: `${r.journey} [${r.mode}]${step ? `, step ${step}` : ""}` },
      },
    ];
    for (const f of r.findings) {
      used.add(f.rule);
      sarifResults.push({
        ruleId: f.rule,
        level: f.level === "error" ? "error" : "warning",
        message: { text: `${f.message}${f.element ? ` At ${f.element}.` : ""}${f.count > 1 ? ` (${f.count} times)` : ""}` },
        locations: location(f.element, f.step),
        properties: { journey: r.journey, mode: r.mode, count: f.count },
      });
    }
    for (const e of r.expectations.filter((x) => !x.ok)) {
      used.add("check-failed");
      sarifResults.push({
        ruleId: "check-failed",
        level: "error",
        message: { text: `${e.text}: ${e.detail ?? "failed"}` },
        locations: location(null, e.step),
        properties: { journey: r.journey, mode: r.mode },
      });
    }
    if (r.status === "error") {
      used.add("journey-error");
      sarifResults.push({ ruleId: "journey-error", level: "error", message: { text: r.error ?? "error" }, locations: location(null, null) });
    }
  }
  return `${JSON.stringify(
    {
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: TOOL.name,
              version: TOOL.version,
              informationUri: TOOL.uri,
              rules: [...used].map((id) => ({ id, shortDescription: { text: RULES[id] ?? id } })),
            },
          },
          results: sarifResults,
        },
      ],
    },
    null,
    2
  )}\n`;
}

// ---------- CSV ----------

const csvCell = (value) => {
  let text = String(value ?? "");
  // A leading =, +, - or @ makes spreadsheets treat the cell as a formula; page text is untrusted.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const csv = (rows) => rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function renderFindingsCsv(results) {
  return csv([
    ["journey", "mode", "level", "rule", "message", "element", "times", "first_step", "url"],
    ...results.flatMap((r) => r.findings.map((f) => [r.journey, r.mode, f.level, f.rule, f.message, f.element ?? "", f.count, f.step, r.url])),
  ]);
}

export function renderChecksCsv(results) {
  return csv([
    ["journey", "mode", "result", "check", "detail", "step", "url"],
    ...results.flatMap((r) => r.expectations.map((e) => [r.journey, r.mode, e.ok ? "pass" : "fail", e.text, e.detail ?? "", e.step, r.url])),
  ]);
}
