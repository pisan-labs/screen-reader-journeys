// The in-process worker: claim the oldest queued run, run it, save the reports, record the
// results. One run at a time. `db` is workerDb() from worker-db.js: the token-checked worker_*
// functions, and nothing else (or a fake with the same methods, in the tests).

import { chown, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, sep } from "node:path";
import { findJourney } from "./catalog.js";
import { executeRun } from "./execute.js";
import { resolveEgress } from "./hosts.js";
import { validateRunRequest } from "./validate.js";

/** A report larger than this is left out (the database refuses it); the summary says so. */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** A run still "running" this long after its timeout belonged to a server that stopped. */
const STALE_GRACE_MS = 10 * 60 * 1000;

const CONTENT_TYPES = {
  ".md": "text/markdown; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".xml": "application/xml",
  ".sarif": "application/sarif+json",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const short = (text, max = 500) => {
  const line = String(text ?? "").split("\n")[0];
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

async function listFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { recursive: true })) {
    if ((await stat(join(dir, entry))).isFile()) files.push(entry.split(sep).join("/"));
  }
  return files.sort();
}

export function summarizeRun({ results, blocked, outcome }, files, skipped = []) {
  return {
    results: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    errored: results.filter((r) => r.status === "error").length,
    errors: results.reduce((sum, r) => sum + r.errors, 0),
    warnings: results.reduce((sum, r) => sum + r.warnings, 0),
    files,
    ...(skipped.length ? { skipped_files: skipped } : {}),
    blocked_requests: [...new Set(blocked)].slice(0, 50),
    timed_out: outcome === "timeout",
  };
}

export function createWorker({ db, catalog, config, execute = executeRun, lookup, log = console }) {
  let stopping = false;
  let loop = null;
  let current = null; // AbortController of the run in progress
  let wake = () => {};

  const failStaleRuns = () => db.failStaleRuns((config.runTimeoutMs + STALE_GRACE_MS) / 1000);

  async function finish(run, fields) {
    await db.finish(run.id, fields);
    log.log(`run ${run.id}: ${fields.status}${fields.error ? ` (${fields.error})` : ""}`);
  }

  /** Save each report file the run wrote. Resolves to the saved paths and the ones left out. */
  async function saveReports(runId, dir) {
    const saved = [];
    const skipped = [];
    for (const file of await listFiles(dir)) {
      const type = CONTENT_TYPES[extname(file)];
      const body = type ? await readFile(join(dir, file), "utf8") : null;
      if (!type || Buffer.byteLength(body) > MAX_REPORT_BYTES) {
        skipped.push(file);
        log.log(`run ${runId}: left out ${file} (${type ? "too large" : "not a report type"})`);
        continue;
      }
      if (!(await db.saveReport(runId, file, type, body))) break; // the run was deleted
      saved.push(file);
    }
    return { saved, skipped };
  }

  async function recordResults(runId, results, files) {
    if (!results.length) return;
    const rows = results.map((r) => {
      const report = `${r.report_base}.md`;
      return {
        journey: r.journey,
        mode: r.mode,
        status: r.status,
        checks_passed: r.checks_passed,
        checks_total: r.checks_total,
        errors: r.errors,
        warnings: r.warnings,
        report_path: files.includes(report) ? report : null,
      };
    });
    await db.addResults(runId, rows);
  }

  /**
   * A private folder for the run: reports/ for its output and home/ for the browser's own files.
   * With `runAs`, both belong to that user, the only one the run process can write as.
   */
  async function makeWorkDir() {
    const workDir = await mkdtemp(join(tmpdir(), "srj-run-"));
    const outDir = join(workDir, "reports");
    const home = join(workDir, "home");
    await mkdir(outDir);
    await mkdir(home);
    if (config.runAs) for (const dir of [workDir, outDir, home]) await chown(dir, config.runAs.uid, config.runAs.gid);
    return { workDir, outDir, home };
  }

  /** Run one claimed run to the end. Never throws for a problem with the run itself. */
  async function processRun(run) {
    // Set before anything slow, so that a shutdown from here on puts the run back in the queue.
    current = new AbortController();
    if (stopping) current.abort();
    let workDir = null;
    try {
      log.log(`run ${run.id}: started (${run.base_url})`);
      // Check again: a user can insert a queued run straight into the table, past the API.
      const request = validateRunRequest(run, { catalog, rules: config.targetRules });
      if (!request.ok) return await finish(run, { status: "failed", error: `Refused: ${request.errors.map((e) => e.message).join(" ")}` });
      const target = new URL(request.value.base_url);
      const egress = await resolveEgress(target.hostname, Number(target.port || (target.protocol === "https:" ? 443 : 80)), config.targetRules, lookup);
      if (!egress.ok) return await finish(run, { status: "failed", error: `Refused: ${egress.reason}.` });

      const dirs = await makeWorkDir();
      workDir = dirs.workDir;
      const outDir = dirs.outDir;
      const job = {
        baseUrl: request.value.base_url,
        journeys: request.value.journeys.map((path) => ({ path, file: findJourney(catalog, path).file })),
        modes: request.value.modes,
        outDir,
        allowedTargetHosts: config.allowedTargetHosts,
        chromiumSandbox: config.chromiumSandbox,
      };
      const runAs = config.runAs ? { ...config.runAs, home: dirs.home } : null;
      const outcome = await execute(job, { timeoutMs: config.runTimeoutMs, signal: current.signal, runAs });
      if (outcome.outcome === "aborted") {
        // The server is shutting down (a deploy, say): put the run back for the next instance.
        await db.requeue(run.id);
        log.log(`run ${run.id}: requeued`);
        return;
      }
      const { saved: files, skipped } = await saveReports(run.id, outDir);
      await recordResults(run.id, outcome.results, files);
      const summary = summarizeRun(outcome, files, skipped);
      const expected = job.journeys.length * job.modes.length;
      if (outcome.outcome === "done") return await finish(run, { status: "done", error: null, summary });
      const error =
        outcome.outcome === "timeout"
          ? `Timed out after ${Math.round(config.runTimeoutMs / 1000)} seconds; ${outcome.results.length} of ${expected} journey runs finished.`
          : short(outcome.error ?? "The run failed.");
      return await finish(run, { status: "failed", error, summary });
    } catch (error) {
      // The details (database messages) go to the log, not to the user.
      log.error(`run ${run.id}: ${error.stack ?? error}`);
      await finish(run, { status: "failed", error: "The server could not finish this run. Try again, or ask the administrator to check the server log." }).catch((e) =>
        log.error(e.message)
      );
    } finally {
      current = null;
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Claim and process one run. Resolves to true if there was one. */
  async function tick() {
    await failStaleRuns();
    if (stopping) return false; // do not claim a run this server would have to give back
    const run = await db.claim();
    if (!run) return false;
    await processRun(run);
    return true;
  }

  const pause = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function run() {
    while (!stopping) {
      let worked = false;
      try {
        worked = await tick();
      } catch (error) {
        log.error(`worker: ${error.message}`);
      }
      if (!worked && !stopping) await pause(config.pollIntervalMs);
    }
  }

  return {
    tick,
    start() {
      loop ??= run();
      return loop;
    },
    /** Stop polling; a run in progress is stopped and put back in the queue. */
    async stop() {
      stopping = true;
      current?.abort();
      wake();
      await loop;
    },
    get busy() {
      return current !== null;
    },
  };
}
