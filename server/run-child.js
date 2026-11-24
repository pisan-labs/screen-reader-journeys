// Runs one run's journeys in a child process, so the worker can stop it at its timeout (the
// browsers go with it) and so the browser never shares a process, or an environment, with the
// Supabase keys. The parent sends one job; this process reports each result as it finishes,
// keeps the reports in job.outDir up to date, and exits.

import { createWriteStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadJourney, runJourney } from "../src/journey.js";
import { slug, writeReports } from "../src/report.js";
import { startEgressProxy } from "./egress-proxy.js";
import { parseAllowedHosts } from "./hosts.js";

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
 * job: { baseUrl, journeys: [{ path, file }], modes, outDir, allowedTargetHosts, chromiumSandbox }
 * send(message): receives { type: "result", result, blocked } after each journey and mode.
 *
 * @param {any} job
 * @param {(message: object) => void} send
 * @param {{ lookup?: (host: string) => Promise<string[]> }} [options]
 */
export async function runJob(job, send, { lookup } = {}) {
  const proxy = await startEgressProxy({ rules: parseAllowedHosts(job.allowedTargetHosts), lookup });
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
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Playwright closes its browsers on SIGTERM but leaves the process running; exit soon after.
  process.on("SIGTERM", () => setTimeout(() => process.exit(143), 1500).unref());
  // The job comes on stdin; messages go to fd 3, one JSON line each (execute.js, readMessages).
  const out = createWriteStream("", { fd: 3 });
  const send = (message) => out.write(`${JSON.stringify(message)}\n`);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", async () => {
    let last = { type: "done" };
    try {
      await runJob(JSON.parse(input), send);
    } catch (error) {
      last = { type: "error", message: String(error?.message ?? error).split("\n")[0].slice(0, 100_000) };
    }
    out.end(`${JSON.stringify(last)}\n`, () => process.exit(0));
  });
}
