// Start a run's child process and wait for it, with a timeout and a way to abort it.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./run-child.js", import.meta.url));

// Only these variables reach the process that drives the browser: no credentials, and not
// Playwright's switch for letting loopback bypass the proxy. SRJ_TEST_* are the self-tests' own.
const PASSED = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "NODE_ENV", "PLAYWRIGHT_BROWSERS_PATH"];
const passes = (name) => PASSED.includes(name) || name.startsWith("SRJ_TEST_");

export function childEnv(env = process.env, overrides = {}) {
  const passed = Object.fromEntries(Object.entries(env).filter(([name, value]) => passes(name) && value !== undefined));
  return { ...passed, ...overrides };
}

/**
 * Run `job` (see run-child.js) in a child process. Resolves, never rejects, with
 * `{ outcome: "done" | "timeout" | "aborted" | "error", error, results, blocked }`, where
 * `results` holds every journey and mode that finished, even after a timeout.
 *
 * `runAs: { uid, gid, home }` starts the process as that user, so that a page that breaks out of
 * the browser cannot read this server's environment (its Supabase keys) through /proc. This
 * server must then run as root, as it does in the Docker image.
 *
 * @param {object} job
 * @param {{ timeoutMs?: number, signal?: AbortSignal, killAfterMs?: number, runAs?: { uid: number, gid: number, home?: string } | null }} [options]
 * @returns {Promise<{ outcome: string, error: string | null, results: any[], blocked: string[] }>}
 */
export function executeRun(job, { timeoutMs, signal, killAfterMs = 5000, runAs = null } = {}) {
  return new Promise((resolve) => {
    const results = [];
    const blocked = [];
    let outcome = null;
    let error = null;
    let settled = false;
    const child = fork(CHILD, [], {
      // None of this server's node flags: under `npm run server:dev`, --env-file-if-exists=.env
      // would otherwise load .env (WORKER_TOKEN) into the run's own environment.
      execArgv: [],
      env: childEnv(process.env, runAs?.home ? { HOME: runAs.home } : {}),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "json",
      ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
    });

    const stop = (why) => {
      outcome ??= why;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), killAfterMs).unref();
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ outcome, error, results, blocked });
    };

    child.on("message", (/** @type {any} */ message) => {
      if (message?.type === "result") {
        results.push(message.result);
        blocked.push(...(message.blocked ?? []));
      } else if (message?.type === "done") {
        outcome ??= "done";
      } else if (message?.type === "error") {
        outcome ??= "error";
        error = message.message;
      }
    });
    child.on("error", (spawnError) => {
      outcome ??= "error";
      error ??= `Could not start the run process: ${spawnError.message}`;
      settle();
    });
    child.on("exit", (code, signalName) => {
      if (!outcome) {
        outcome = "error";
        error = `The run process stopped unexpectedly (${signalName ?? `exit code ${code}`}).`;
      }
      settle();
    });
    child.send(job);
  });
}
