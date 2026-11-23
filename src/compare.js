// Compare what different modes (or the same mode on two sites) heard on the same journey, step by
// step: the walker, the emulated screen reader, NVDA and Orca side by side, or a pull request's
// preview next to the main site.
//
// Every mode presses the same keys through the real browser keyboard, so their steps usually line
// up. Where they do not (reading line by line exists only in some modes, or one run stopped
// early), the steps are aligned on their actions, as a diff would.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { escapeHtml, htmlPage, statusBadge } from "./formats.js";
import { slug } from "./slug.js";

export const COMPARE_FORMATS = ["md", "html", "json"];

const MODE_ORDER = ["walker", "virtual", "voiceover", "orca", "nvda"];
/** Longest stretch of speech shown in one cell; the per-mode report has the rest. */
const MAX_PHRASES = 20;
const READ_PAGE = "read the page";

const isResult = (value) =>
  value && typeof value === "object" && typeof value.journey === "string" && typeof value.mode === "string" && Array.isArray(value.steps);

/** Read result JSON files (`<journey>.<mode>.json`), from files or folders searched for them. */
export async function loadResults(paths) {
  const files = [];
  for (const path of paths) {
    if ((await stat(path)).isDirectory()) {
      for (const entry of await readdir(path, { recursive: true })) {
        if (entry.endsWith(".json") && !entry.split(/[\\/]/).includes("node_modules")) files.push(join(path, entry));
      }
    } else files.push(path);
  }
  const results = [];
  for (const file of files.sort()) {
    let value;
    try {
      value = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue; // not JSON, or not ours
    }
    if (!isResult(value)) continue;
    // Where the result came from, so a comparison written elsewhere can link to its reports.
    Object.defineProperty(value, "source", { value: file, enumerable: false });
    results.push(value);
  }
  return results;
}

/** One run's steps as rows: consecutive "read next" steps become one "read the page" row. */
function rowsOf(result) {
  const rows = [];
  for (const step of result.steps) {
    const isNote = step.action.startsWith("note: ");
    const unsupportedRead = isNote && /line by line/i.test(step.action);
    if (step.action === "read next" || unsupportedRead) {
      const previous = rows.at(-1);
      if (previous?.key === READ_PAGE) {
        previous.spoken.push(...step.spoken);
        continue;
      }
      rows.push({
        key: READ_PAGE,
        action: READ_PAGE,
        spoken: unsupportedRead ? [] : [...step.spoken],
        note: unsupportedRead ? step.action.slice(6) : null,
        focus: null,
        step: step.n,
      });
      continue;
    }
    rows.push({
      // Notes ("Tab order: 12 stops") line up with each other even when their text differs.
      key: isNote ? "note" : step.action,
      action: isNote ? "note" : step.action,
      spoken: [...step.spoken],
      note: isNote ? step.action.slice(6) : null,
      focus: step.focus,
      step: step.n,
    });
  }
  return rows;
}

/** Merge each run's rows into shared rows, matching actions in order (a longest-common-subsequence diff). */
function alignRows(runs) {
  let merged = runs[0].map((row) => ({ key: row.key, cells: [row] }));
  for (let m = 1; m < runs.length; m++) {
    const a = merged.map((row) => row.key);
    const b = runs[m].map((row) => row.key);
    const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        merged[i].cells[m] = runs[m][j];
        out.push(merged[i]);
        i++;
        j++;
      } else if (i < a.length && (j >= b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
        out.push(merged[i]);
        i++;
      } else {
        const row = { key: b[j], cells: [] };
        row.cells[m] = runs[m][j];
        out.push(row);
        j++;
      }
    }
    merged = out;
  }
  return merged;
}

const counts = (r) => ({
  checks: r.expectations?.length ?? 0,
  passed: (r.expectations ?? []).filter((e) => e.ok).length,
  errors: (r.findings ?? []).filter((f) => f.level === "error").length,
  warnings: (r.findings ?? []).filter((f) => f.level === "warning").length,
});

const focusLabel = (focus) => (focus ? `${focus.role ?? "?"} "${focus.name ?? ""}"` : null);
const isMove = (action) => /^(shift\+)?tab$/i.test(action);

/** Name each column by its mode, adding the site and a number only where needed to tell columns apart. */
function columnLabels(results) {
  const hosts = new Set(results.map((r) => safeHost(r.url)));
  const labels = results.map((r) => (hosts.size > 1 ? `${r.mode} (${safeHost(r.url)})` : r.mode));
  const seen = new Map();
  return labels.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n > 1 || labels.filter((l) => l === label).length > 1 ? `${label} #${n}` : label;
  });
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url ?? "");
  }
}

/** Whether `results` holds at least one journey run more than once (in two modes, or on two sites). */
export function hasComparison(results) {
  const names = results.map((r) => r.journey);
  return names.some((name, i) => names.indexOf(name) !== i);
}

/**
 * Line up the results by journey. Returns, for each journey run more than once, its columns (one
 * per run) and rows (one per step), with each row's differences:
 *   silent         a screen reader said nothing after Tab or Shift+Tab
 *   focus differs  the runs were on different elements after the same step
 *   missing        a run has no such step (for example, it stopped early)
 */
export function compareResults(results) {
  const byJourney = new Map();
  for (const result of results) {
    if (!byJourney.has(result.journey)) byJourney.set(result.journey, []);
    byJourney.get(result.journey).push(result);
  }
  const journeys = [];
  for (const [journey, group] of byJourney) {
    if (group.length < 2) continue;
    const runs = [...group].sort((a, b) => order(a.mode) - order(b.mode));
    const labels = columnLabels(runs);
    const aligned = alignRows(runs.map(rowsOf));
    const rows = aligned.map((row, index) => {
      const cells = runs.map((run, m) => {
        const cell = row.cells[m];
        if (!cell) return { state: "missing", text: [] };
        if (cell.note) return { state: "note", text: [cell.note], step: cell.step };
        if (!cell.spoken.length) return { state: "silent", text: [], step: cell.step, focus: focusLabel(cell.focus) };
        return { state: "heard", text: cell.spoken, step: cell.step, focus: focusLabel(cell.focus) };
      });
      const action = row.cells.find(Boolean).action;
      const differences = [];
      // The walker speaks only when focus moves, so its silence is not a finding.
      const silent = isMove(action) ? labels.filter((label, m) => runs[m].mode !== "walker" && cells[m].state === "silent") : [];
      if (silent.length) differences.push(`silent in ${silent.join(", ")}`);
      const focuses = new Set(cells.map((c) => c.focus).filter(Boolean));
      if (focuses.size > 1) differences.push("focus differs");
      const missing = cells.map((c, m) => (c.state === "missing" ? labels[m] : null)).filter(Boolean);
      if (missing.length) differences.push(`missing in ${missing.join(", ")}`);
      return { n: index + 1, action, cells, differences };
    });
    journeys.push({
      journey,
      description: runs[0].description ?? "",
      columns: runs.map((run, m) => ({
        label: labels[m],
        mode: run.mode,
        modeLabel: run.modeLabel ?? run.mode,
        browser: run.browser ?? null,
        url: run.url,
        status: run.status,
        error: run.error ?? null,
        // The run's own reports, without the extension: next to this one, or `reportPath` if set.
        report: run.reportPath ?? `${slug(run.journey)}.${run.mode}`,
        ...counts(run),
      })),
      rows,
      differing: rows.filter((r) => r.differences.length).length,
    });
  }
  return { generatedAt: new Date().toISOString(), journeys };
}

const order = (mode) => {
  const i = MODE_ORDER.indexOf(mode);
  return i === -1 ? MODE_ORDER.length : i;
};

const clip = (phrases) =>
  phrases.length > MAX_PHRASES ? [...phrases.slice(0, MAX_PHRASES), `… ${phrases.length - MAX_PHRASES} more in the mode's report`] : phrases;

const cellText = (cell) => {
  if (cell.state === "missing") return "—";
  if (cell.state === "silent") return "(silent)";
  if (cell.state === "note") return cell.text[0];
  return clip(cell.text).join(" / ");
};

const mdCell = (text) => String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const STATUS = { pass: "✅ pass", fail: "❌ fail", error: "⚠️ error" };

export function renderCompare(comparison) {
  const lines = [
    "# Compare modes",
    "",
    "What each run heard at the same step of the same journey. **(silent)** means the run was at",
    "that step and heard nothing; **—** means it has no such step. Screen readers differ, so",
    "differences are not always faults; they show where to listen first.",
    "",
  ];
  if (!comparison.journeys.length) lines.push("No journey was run more than once, so there is nothing to compare.", "");
  for (const j of comparison.journeys) {
    lines.push(`## ${j.journey}`, "");
    if (j.description) lines.push(j.description, "");
    lines.push(
      "| Run | Mode | Result | Checks | Errors | Warnings |",
      "|---|---|---|---|---|---|",
      ...j.columns.map(
        (c) =>
          `| [${mdCell(c.label)}](${c.report}.md) | ${mdCell(c.modeLabel)}${c.browser ? `, ${mdCell(c.browser)}` : ""} | ${STATUS[c.status] ?? mdCell(c.status)}${c.error ? ` (${mdCell(c.error)})` : ""} | ${c.passed}/${c.checks} | ${c.errors} | ${c.warnings} |`
      ),
      "",
      `${j.differing} of ${j.rows.length} steps differ.`,
      "",
      `| # | Action | ${j.columns.map((c) => mdCell(c.label)).join(" | ")} | Differences |`,
      `|---|---|${j.columns.map(() => "---|").join("")}---|`,
      ...j.rows.map((r) => `| ${r.n} | ${mdCell(r.action)} | ${r.cells.map((c) => mdCell(cellText(c))).join(" | ")} | ${mdCell(r.differences.join("; "))} |`),
      ""
    );
  }
  return lines.join("\n");
}

const COMPARE_STYLE = `
.silent, .missing { font-style: italic; color: var(--muted); }
td.differs { font-weight: 600; }
`;

export function renderCompareHtml(comparison) {
  const sections = comparison.journeys.map((j, index) => {
    const runs = `<div class="table-wrap" role="region" aria-labelledby="runs-${index}" tabindex="0"><table><caption id="runs-${index}">Runs of ${escapeHtml(j.journey)}</caption><thead><tr><th scope="col">Run</th><th scope="col">Mode</th><th scope="col">Result</th><th scope="col">Checks passed</th><th scope="col">Errors</th><th scope="col">Warnings</th></tr></thead><tbody>${j.columns
      .map(
        (c) =>
          `<tr><th scope="row"><a href="${escapeHtml(`${c.report}.html`)}">${escapeHtml(c.label)}</a></th><td>${escapeHtml(c.modeLabel)}${c.browser ? `, ${escapeHtml(c.browser)}` : ""}</td><td>${statusBadge(c.status)}${c.error ? ` (${escapeHtml(c.error)})` : ""}</td><td>${c.passed} of ${c.checks}</td><td>${c.errors}</td><td>${c.warnings}</td></tr>`
      )
      .join("")}</tbody></table></div>`;
    const cellHtml = (c) => {
      if (c.state === "missing") return `<td class="missing">no such step</td>`;
      if (c.state === "silent") return `<td class="silent">silent</td>`;
      if (c.state === "note") return `<td>${escapeHtml(c.text[0])}</td>`;
      return `<td>${clip(c.text).map(escapeHtml).join("<br>")}</td>`;
    };
    const steps = `<div class="table-wrap" role="region" aria-labelledby="steps-${index}" tabindex="0"><table><caption id="steps-${index}">What each run heard, step by step (${j.differing} of ${j.rows.length} steps differ)</caption><thead><tr><th scope="col">Step</th>${j.columns
      .map((c) => `<th scope="col">${escapeHtml(c.label)}</th>`)
      .join("")}<th scope="col">Differences</th></tr></thead><tbody>${j.rows
      .map(
        (r) =>
          `<tr><th scope="row">${r.n}. ${escapeHtml(r.action)}</th>${r.cells.map(cellHtml).join("")}<td${r.differences.length ? ' class="differs"' : ""}>${escapeHtml(r.differences.join("; ")) || "None"}</td></tr>`
      )
      .join("")}</tbody></table></div>`;
    return `<section aria-labelledby="journey-${index}"><h2 id="journey-${index}">${escapeHtml(j.journey)}</h2>
${j.description ? `<p>${escapeHtml(j.description)}</p>` : ""}
${runs}
${steps}</section>`;
  });
  return htmlPage(
    "Compare modes",
    `<h1>Compare modes</h1>
<p>What each run heard at the same step of the same journey. “Silent” means the run was at that step and heard nothing; “no such step” means it has none. Screen readers differ, so differences are not always faults; they show where to listen first.</p>
${sections.length ? sections.join("\n") : "<p>No journey was run more than once, so there is nothing to compare.</p>"}`,
    COMPARE_STYLE
  );
}
