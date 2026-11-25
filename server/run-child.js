// Runs one run's journeys in a child process, so the worker can stop it at its timeout (the
// browsers go with it) and so the browser never shares a process, or an environment, with the
// Supabase keys. The parent sends one job; this process reports each result as it finishes,
// keeps the reports in job.outDir up to date, and exits.

import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadJourney, runJourney, skippedResult, startUrl } from "../src/journey.js";
import { slug, writeReports } from "../src/report.js";
import { startEgressProxy } from "./egress-proxy.js";
import { needsSandbox, parseAllowedHosts } from "./hosts.js";

/** The longest error a result carries, in code points (R9.6). */
export const RESULT_ERROR_POINTS = 10_000;

/**
 * At most `max` code points of `text`, well formed. The cut is taken from a bounded slice first,
 * which holds at least `max` code points.
 */
const points = (text, max) => Array.from(String(text).slice(0, 2 * max).toWellFormed()).slice(0, max).join("");

/**
 * The numbers the database keeps for one journey in one mode. The error is cut, so that a valid
 * result always fits in one message (execute.js, MAX_MESSAGE): even fully escaped, 10,000 code
 * points stay under 262,144 characters.
 */
export function summarizeResult(result, path) {
  const failed = result.expectations.filter((e) => !e.ok).length;
  return {
    journey: path,
    name: result.journey,
    mode: result.mode,
    status: result.status,
    error: result.error == null ? null : points(result.error, RESULT_ERROR_POINTS),
    checks_total: result.expectations.length,
    checks_passed: result.expectations.length - failed,
    errors: result.findings.filter((f) => f.level === "error").length,
    warnings: result.findings.filter((f) => f.level === "warning").length,
    report_base: `${slug(result.journey)}.${result.mode}`,
    // The page never went quiet: it may still have been loading (src/journey.js).
    ...(result.stillLoading ? { still_loading: true } : {}),
  };
}

/** How often, at most, a run's progress reports its step. */
export const PROGRESS_EVERY_MS = 1000;

/**
 * Send the proxy's refusals not yet sent with a result, if any: at the end of a job (the byte
 * limit can trip as the proxy closes), and when the run is stopped (R9.3), so the run's summary
 * always carries them, the byte limit's entry first.
 */
export function sendLeftover(proxy, send) {
  const left = proxy?.blocked.splice(0) ?? [];
  if (left.length) send({ type: "blocked", blocked: left });
}

/**
 * job: { baseUrl, journeys: [{ path, file }], modes, outDir, allowedTargetHosts, chromiumSandbox }
 * send(message): receives { type: "progress", ... } as each journey and mode starts and moves
 * on, { type: "result", result, blocked } after each, and { type: "blocked", blocked } with any
 * refusals left at the end.
 *
 * Once `stopped()` is true (the run's timeout or a stop: run-child's SIGTERM), no new journey or
 * mode starts, and a result that ends after it is not sent or saved: the stop made it, closing
 * the browser under it (R9.2). Its refusals still go out, with what is left at the end.
 *
 * Once a journey's page has not loaded in time (runJourney's `notLoaded`), the run's other
 * journeys and modes that open that same page are not run: a site that never loads costs one
 * load timeout for each distinct start page, not the whole run timeout (R22.1-2, R22.2-3,
 * R22.3-2). Each gets a full result and a report that says why (R22.2-1).
 *
 * @param {any} job
 * @param {(message: object) => void} send
 * @param {{ lookup?: (host: string) => Promise<string[]>, startProxy?: typeof startEgressProxy, onProxy?: (proxy: any) => void, stopped?: () => boolean, load?: typeof loadJourney, run?: typeof runJourney, write?: typeof writeReports, progressEveryMs?: number }} [options]
 *   `startProxy`, `load`, `run`, `write` (the tests' own), `onProxy` (told of the proxy, so a stop
 *   can send what is left)
 */
export async function runJob(job, send, { lookup, startProxy = startEgressProxy, onProxy = () => {}, stopped = () => false, load = loadJourney, run = runJourney, write = writeReports, progressEveryMs = PROGRESS_EVERY_MS } = {}) {
  const rules = parseAllowedHosts(job.allowedTargetHosts);
  // As in the worker: with "*" or a wildcard, never a browser without its sandbox.
  if (needsSandbox(rules) && !job.chromiumSandbox) throw new Error('ALLOWED_TARGET_HOSTS with "*" or a wildcard rule needs Chromium\'s sandbox');
  const proxy = await startProxy({ rules, lookup });
  onProxy(proxy);
  const launchOptions = {
    proxy: { server: proxy.server },
    chromiumSandbox: !!job.chromiumSandbox,
    // QUIC and WebRTC's UDP would not go through the proxy, so neither may be used.
    args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
  };
  const results = [];
  /** Start pages that did not load, and why the journeys that open them are not run. */
  const unloaded = new Map();
  try {
    for (const { path, file } of job.journeys) {
      if (stopped()) break;
      const journey = await load(file);
      for (const mode of job.modes) {
        if (stopped()) break;
        const why = unloaded.size ? unloaded.get(startUrl(journey, job.baseUrl)) : undefined;
        if (why) {
          const skipped = skippedResult(journey, { mode, baseUrl: job.baseUrl }, why);
          results.push(skipped);
          await write(results, job.outDir);
          send({ type: "result", result: summarizeResult(skipped, path), blocked: proxy.blocked.splice(0) });
          continue;
        }
        // Progress for the run's page: this journey and mode, then its steps, at most one each
        // `progressEveryMs`, and the latest one at the end of that time, so the step shown is
        // never stale (R19.1-7). Nothing once the journey has returned.
        send({ type: "progress", journey: path, mode });
        let told = 0;
        let latest = null;
        let timer = null;
        let finished = false;
        const tell = (step) => {
          told = Date.now();
          send({ type: "progress", journey: path, mode, step: String(step.action).slice(0, 200), n: step.n });
        };
        const onStep = (step) => {
          if (finished) return;
          const wait = told + progressEveryMs - Date.now();
          if (wait <= 0 && !timer) return tell(step);
          latest = step;
          // Cleared when the journey returns, so it never sends after that.
          timer ??= setTimeout(() => {
            timer = null;
            tell(latest);
          }, Math.max(wait, 0));
        };
        let result;
        try {
          result = await run(journey, { mode, baseUrl: job.baseUrl, launchOptions, onStep });
        } finally {
          finished = true;
          clearTimeout(timer);
        }
        if (stopped()) break;
        if (result.notLoaded) unloaded.set(result.url, `Not run: ${result.url} did not load in an earlier journey (${result.error})`);
        results.push(result);
        await write(results, job.outDir);
        send({ type: "result", result: summarizeResult(result, path), blocked: proxy.blocked.splice(0) });
      }
    }
  } finally {
    await proxy.close();
    sendLeftover(proxy, send);
  }
}

/**
 * Sends each message as one JSON line on `out`, and nothing once `out` has ended: a stop may
 * come after the last message has gone.
 *
 * @param {{ writableEnded: boolean, write: (line: string) => unknown }} out
 */
export function sender(out) {
  return (/** @type {object} */ message) => {
    if (!out.writableEnded) out.write(`${JSON.stringify(message)}\n`);
  };
}

/** The first line of an error, bounded. */
const firstLine = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 100_000);

/**
 * The run process, around runJob. `start(input)` runs the job given as JSON, then sends `done`
 * (or `error`) and exits 0 once that is written.
 *
 * `stop()` is for SIGTERM. Playwright closes its browsers then, but the job may not end by
 * itself (a journey waiting on a page that is gone). So no new journey or mode starts (runJob's
 * `stopped`), and the refusals the run's summary should carry are sent (R9.3): those left now,
 * and, once the job has ended or `graceMs` has passed, those made since, the byte limit tripping
 * as the proxy closes included (R20.1-3, R20.2-1). Then the messages end, and it exits 143 once
 * they are written, or 500 ms after that. 3 s and 0.5 s stay under the worker's 5 s SIGKILL.
 *
 * @param {{ out: { writableEnded: boolean, write: (line: string) => unknown, end: (...args: any[]) => unknown }, exit: (code: number) => void, run?: typeof runJob, graceMs?: number }} options
 */
export function runProcess({ out, exit, run = runJob, graceMs = 3000 }) {
  const send = sender(out);
  let proxy = null;
  let stopping = false;
  /** @type {Promise<object> | null} */
  let job = null;
  const end = (line, code) => {
    if (out.writableEnded) return;
    if (line) out.end(line, () => exit(code));
    else out.end(() => exit(code));
  };
  return {
    start(input) {
      job = (async () => {
        try {
          await run(JSON.parse(input), send, { onProxy: (p) => (proxy = p), stopped: () => stopping });
          return { type: "done" };
        } catch (error) {
          return { type: "error", message: firstLine(error) };
        }
      })();
      // After a stop, the stop ends the messages and exits.
      job.then((last) => stopping || end(`${JSON.stringify(last)}\n`, 0));
    },
    stop() {
      if (stopping) return;
      stopping = true;
      sendLeftover(proxy, send);
      const grace = new Promise((resolve) => setTimeout(resolve, graceMs).unref());
      Promise.race([job ?? grace, grace]).then(() => {
        sendLeftover(proxy, send);
        end("", 143);
        setTimeout(() => exit(143), 500).unref();
      });
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The job comes on stdin; messages go to fd 3, one JSON line each (execute.js, readMessages).
  const out = createWriteStream("", { fd: 3 });
  // A server that has stopped reading is no reason to crash before exiting.
  out.on("error", () => {});
  const runner = runProcess({ out, exit: (code) => process.exit(code) });
  process.on("SIGTERM", () => runner.stop());
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => runner.start(input));
}
