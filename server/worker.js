// The in-process worker: claim the oldest queued run, run it, save the reports, record the
// results. One run at a time. `db` is workerDb() from worker-db.js: the token-checked worker_*
// functions, and nothing else (or a fake with the same methods, in the tests).

import { chmod, chown, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { findJourney } from "./catalog.js";
import { executeRun } from "./execute.js";
import { resolveEgress } from "./hosts.js";
import { checkReportsFolder, listReportFiles, readReportFile, recordReportsFolder, stopUserProcesses } from "./reports.js";
import { validateRunRequest } from "./validate.js";

/** A report larger than this is left out (the database refuses it); the summary says so. */
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/** The report paths the database takes (run_reports.path's check). */
const REPORT_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** How often the worker deletes finished runs over 30 days old. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

/**
 * The database's refusals of one report, which leave that file out: a per-run cap (54000), a
 * check constraint (23514), and text it cannot hold (22P05). Any other error fails the run.
 */
const REFUSALS = new Set(["54000", "23514", "22P05"]);

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

export function createWorker({ db, catalog, config, execute = executeRun, lookup, log = console, stopProcesses = (runAs) => stopUserProcesses(runAs.uid, { gid: runAs.gid }) }) {
  let stopping = false;
  let loop = null;
  let current = null; // AbortController of the run in progress
  let wake = () => {};

  const failStaleRuns = () => db.failStaleRuns((config.runTimeoutMs + STALE_GRACE_MS) / 1000);

  async function finish(run, fields) {
    await db.finish(run.id, fields);
    log.log(`run ${run.id}: ${fields.status}${fields.error ? ` (${fields.error})` : ""}`);
  }

  /** With RUN_AS_UID, end every process of that user: nothing of a run may outlive it. */
  async function stopRunProcesses() {
    if (config.runAs) await stopProcesses(config.runAs);
  }

  /**
   * Save each report file the run wrote. Resolves to the saved paths and the ones left out. A
   * file the database refuses is left out, never a reason to fail a run that finished.
   *
   * The run's process wrote these files, so they are not trusted (reports.js): by now none of
   * its processes is left; links, FIFOs and other non-files are left out; and each file is
   * opened without following links, its size checked on the open handle and read no further
   * than the limit. Its name is checked before it is sent.
   */
  async function saveReports(runId, dir, { realRoot, uid }) {
    const saved = [];
    const skipped = [];
    const leaveOut = (file, why) => {
      skipped.push(file);
      log.log(`run ${runId}: left out ${file} (${why})`);
    };
    const { files, others } = await listReportFiles(dir);
    for (const file of others) leaveOut(file, "a link or other non-file");
    for (const file of files) {
      const type = CONTENT_TYPES[extname(file)];
      if (!type) {
        leaveOut(file, "not a report type");
        continue;
      }
      if (file.length > 200 || !REPORT_PATH.test(file)) {
        leaveOut(file, "a name the database does not take");
        continue;
      }
      const read = await readReportFile(dir, file, MAX_REPORT_BYTES, { realRoot, uid });
      if ("refused" in read) {
        leaveOut(file, read.refused);
        continue;
      }
      // A text column cannot hold U+0000, which a tested page can put in an accessible name;
      // replace it as an HTML parser would.
      const body = read.text.replaceAll("\u0000", "\uFFFD");
      let kept;
      try {
        kept = await db.saveReport(runId, file, type, body);
      } catch (error) {
        if (!REFUSALS.has(error.code)) throw error;
        leaveOut(file, error.message);
        continue;
      }
      if (!kept) break; // the run was deleted
      saved.push(file);
    }
    skipped.sort();
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
    // The work folder stays the server's, so the run cannot rename or replace reports/ or home/
    // inside it; only those two are the run user's. 0755 lets that user reach them.
    const workDir = await mkdtemp(join(tmpdir(), "srj-run-"));
    const outDir = join(workDir, "reports");
    const home = join(workDir, "home");
    await mkdir(outDir);
    await mkdir(home);
    if (config.runAs) {
      await chmod(workDir, 0o755);
      for (const dir of [outDir, home]) await chown(dir, config.runAs.uid, config.runAs.gid);
    }
    return { workDir, outDir, home, reports: await recordReportsFolder(outDir) };
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

      // A process left by an earlier run could otherwise write into this person's folder.
      await stopRunProcesses();
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
      // Nothing may write into the folder while it is read, and it must be the folder made for it.
      await stopRunProcesses();
      await checkReportsFolder(dirs.reports);
      const { saved: files, skipped } = await saveReports(run.id, outDir, { realRoot: dirs.reports.real, uid: dirs.reports.uid });
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
      // On every path (done, failed, aborted for a deploy): nothing of this run may outlive it.
      await stopRunProcesses().catch((error) => log.error(`run ${run.id}: stopping its processes: ${error.message}`));
      if (workDir) await rm(workDir, { recursive: true, force: true }).catch((error) => log.error(`run ${run.id}: removing its folder: ${error.message}`));
    }
  }

  let prunedAt = 0;
  /** Retention, about once an hour. A failure is logged and tried an hour later; runs are still claimed. */
  async function prune() {
    if (Date.now() - prunedAt < PRUNE_EVERY_MS) return;
    prunedAt = Date.now();
    try {
      const count = await db.pruneRuns();
      if (count) log.log(`pruned ${count} finished runs over 30 days old`);
    } catch (error) {
      log.error(`pruning: ${error.message}`);
    }
  }

  /** Claim and process one run. Resolves to true if there was one. */
  async function tick() {
    await failStaleRuns();
    await prune();
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
