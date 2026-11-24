// Runs one run's journeys in a child process, so the worker can stop it at its timeout (the
// browsers go with it) and so the browser never shares a process, or an environment, with the
// Supabase keys. The parent sends one job; this process reports each result as it finishes,
// keeps the reports in job.outDir up to date, and exits.

import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadJourney, runJourney } from "../src/journey.js";
import { slug, writeReports } from "../src/report.js";
import { startEgressProxy } from "./egress-proxy.js";
import { needsSandbox, parseAllowedHosts } from "./hosts.js";

/** The numbers the database keeps for one journey in one mode. */
export function summarizeResult(result, path) {
  const failed = result.expectations.filter((e) => !e.ok).length;
  return {
    journey: path,
    name: result.journey,
    mode: result.mode,
    status: result.status,
    error: result.error ?? null,
    checks_total: result.expectations.length,
    checks_passed: result.expectations.length - failed,
    errors: result.findings.filter((f) => f.level === "error").length,
    warnings: result.findings.filter((f) => f.level === "warning").length,
    report_base: `${slug(result.journey)}.${result.mode}`,
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

/** A journey whose page did not load in time (src/journey.js, LOAD_TIMEOUT_MS). */
const LOAD_TIMED_OUT = /^page\.goto: Timeout \d+ms exceeded/;

/** The result of a journey and mode that was not run, and why. */
export function notRun(journey, path, mode, why) {
  return { journey: path, name: journey.name, mode, status: "error", error: why, checks_total: 0, checks_passed: 0, errors: 0, warnings: 0, report_base: `${slug(journey.name)}.${mode}` };
}

/**
 * job: { baseUrl, journeys: [{ path, file }], modes, outDir, allowedTargetHosts, chromiumSandbox }
 * send(message): receives { type: "result", result, blocked } after each journey and mode, and
 * { type: "blocked", blocked } with any refusals left at the end.
 *
 * Every journey of a run opens the same site. Once one's page has not loaded in time, the rest are
 * not run, so a site that never loads does not hold the one worker for the whole run timeout:
 * each gets a result that says why (R22.1-2).
 *
 * @param {any} job
 * @param {(message: object) => void} send
 * @param {{ lookup?: (host: string) => Promise<string[]>, startProxy?: typeof startEgressProxy, onProxy?: (proxy: any) => void, run?: typeof runJourney }} [options]
 *   `startProxy` and `run` (the tests' own), `onProxy` (told of the proxy, so a stop can send
 *   what is left)
 */
export async function runJob(job, send, { lookup, startProxy = startEgressProxy, onProxy = () => {}, run = runJourney } = {}) {
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
  let unreachable = null;
  try {
    for (const { path, file } of job.journeys) {
      const journey = await loadJourney(file);
      for (const mode of job.modes) {
        if (unreachable) {
          send({ type: "result", result: notRun(journey, path, mode, unreachable), blocked: proxy.blocked.splice(0) });
          continue;
        }
        // Progress for the run's page: this journey and mode, then its steps, at most one a second.
        send({ type: "progress", journey: path, mode });
        let told = 0;
        const onStep = (step) => {
          if (Date.now() - told < PROGRESS_EVERY_MS) return;
          told = Date.now();
          send({ type: "progress", journey: path, mode, step: String(step.action).slice(0, 200), n: step.n });
        };
        const result = await run(journey, { mode, baseUrl: job.baseUrl, launchOptions, onStep });
        if (LOAD_TIMED_OUT.test(result.error ?? "")) unreachable = `Not run: the site did not load in an earlier journey (${result.error})`;
        results.push(result);
        await writeReports(results, job.outDir);
        send({ type: "result", result: summarizeResult(result, path), blocked: proxy.blocked.splice(0) });
      }
    }
  } finally {
    await proxy.close();
    sendLeftover(proxy, send);
  }
}

/**
 * Sends each message as one JSON line on `out`, and nothing once `out` has ended: a SIGTERM may
 * come after the last message has gone.
 *
 * @param {{ writableEnded: boolean, write: (line: string) => unknown }} out
 */
export function sender(out) {
  return (/** @type {object} */ message) => {
    if (!out.writableEnded) out.write(`${JSON.stringify(message)}\n`);
  };
}

/**
 * At a stop (SIGTERM). Playwright closes its browsers but leaves the process running, so this
 * sends the refusals the run's summary should carry, then exits (R9.3): those left now, and
 * `waitMs` later those made since (the byte limit can trip on the proxy's tick, or at its close)
 * if the job's own end has not sent them by then (R20.1-3). It exits once they are written, or
 * 500 ms after that.
 *
 * @param {() => { blocked: string[] } | null} proxy
 * @param {(message: object) => void} send
 * @param {{ writableEnded: boolean, end: (done: () => void) => unknown }} out
 * @param {(code: number) => void} exit
 */
export function stopSoon(proxy, send, out, exit, waitMs = 1500) {
  sendLeftover(proxy(), send);
  setTimeout(() => {
    sendLeftover(proxy(), send);
    if (!out.writableEnded) out.end(() => exit(143));
    setTimeout(() => exit(143), 500).unref();
  }, waitMs).unref();
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The job comes on stdin; messages go to fd 3, one JSON line each (execute.js, readMessages).
  const out = createWriteStream("", { fd: 3 });
  // A server that has stopped reading is no reason to crash before exiting.
  out.on("error", () => {});
  const send = sender(out);
  let proxy = null;
  process.on("SIGTERM", () => stopSoon(() => proxy, send, out, (code) => process.exit(code)));
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", async () => {
    let last = { type: "done" };
    try {
      await runJob(JSON.parse(input), send, { onProxy: (p) => (proxy = p) });
    } catch (error) {
      last = { type: "error", message: String(error?.message ?? error).split("\n")[0].slice(0, 100_000) };
    }
    if (out.writableEnded) return;
    out.end(`${JSON.stringify(last)}\n`, () => process.exit(0));
  });
}
