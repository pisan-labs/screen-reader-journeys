// Start a run's child process and wait for it, with a timeout and a way to abort it.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./run-child.js", import.meta.url));

// Nothing that looks like a credential reaches the process that drives the browser, and
// Playwright's switch for letting loopback bypass the proxy is never inherited.
const WITHHELD = /^SUPABASE_|KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|^PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK$/i;

export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !WITHHELD.test(name)));
}

/**
 * Run `job` (see run-child.js) in a child process. Resolves, never rejects, with
 * `{ outcome: "done" | "timeout" | "aborted" | "error", error, results, blocked }`, where
 * `results` holds every journey and mode that finished, even after a timeout.
 */
export function executeRun(job, { timeoutMs, signal, killAfterMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const results = [];
    const blocked = [];
    let outcome = null;
    let error = null;
    let settled = false;
    const child = fork(CHILD, [], { env: childEnv(), stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "json" });

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

    child.on("message", (message) => {
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
