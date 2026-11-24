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
 * send(message): receives { type: "result", result, blocked } after each journey and mode, and
 * { type: "blocked", blocked } with any refusals left at the end.
 *
 * @param {any} job
 * @param {(message: object) => void} send
 * @param {{ lookup?: (host: string) => Promise<string[]>, startProxy?: typeof startEgressProxy, onProxy?: (proxy: any) => void }} [options]
 *   `startProxy` (the tests' own), `onProxy` (told of the proxy, so a stop can send what is left)
 */
export async function runJob(job, send, { lookup, startProxy = startEgressProxy, onProxy = () => {} } = {}) {
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
  try {
    for (const { path, file } of job.journeys) {
      const journey = await loadJourney(file);
      for (const mode of job.modes) {
        const result = await runJourney(journey, { mode, baseUrl: job.baseUrl, launchOptions });
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The job comes on stdin; messages go to fd 3, one JSON line each (execute.js, readMessages).
  const out = createWriteStream("", { fd: 3 });
  const send = (message) => out.write(`${JSON.stringify(message)}\n`);
  let proxy = null;
  // Playwright closes its browsers on SIGTERM but leaves the process running; exit soon after,
  // having sent the refusals the run's summary should carry (R9.3).
  process.on("SIGTERM", () => {
    sendLeftover(proxy, send);
    setTimeout(() => process.exit(143), 1500).unref();
  });
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
    out.end(`${JSON.stringify(last)}\n`, () => process.exit(0));
  });
}
