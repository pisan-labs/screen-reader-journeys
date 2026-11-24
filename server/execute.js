// Start a run's child process and wait for it, with a timeout and a way to abort it.

import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./run-child.js", import.meta.url));

// Only these variables reach the process that drives the browser: no credentials, and not
// Playwright's switch for letting loopback bypass the proxy. SRJ_TEST_* are the self-tests' own.
const PASSED = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "NODE_ENV", "PLAYWRIGHT_BROWSERS_PATH"];
const passes = (name) => PASSED.includes(name) || name.startsWith("SRJ_TEST_");

// What a run process may send. It is our own program, but it runs as the run's user next to a
// browser that a tested page may break out of, so its messages are checked before the worker uses
// them: a message of the wrong shape ends the run, as an error.
const STATUSES = new Set(["pass", "fail", "error"]);
const isCount = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000;
const isText = (s, max) => typeof s === "string" && s.length <= max;
/** A result as summarizeResult (run-child.js) makes it. */
export function isResult(r) {
  return (
    r !== null &&
    typeof r === "object" &&
    isText(r.journey, 500) &&
    isText(r.name, 500) &&
    isText(r.mode, 50) &&
    STATUSES.has(r.status) &&
    (r.error === null || isText(r.error, 100_000)) &&
    ["checks_total", "checks_passed", "errors", "warnings"].every((key) => isCount(r[key])) &&
    r.checks_passed <= r.checks_total &&
    isText(r.report_base, 500)
  );
}
/** The proxy's refusals: strings, "host:port (reason)", each cut here to a bounded length. */
const blockedOf = (list) => (Array.isArray(list) && list.length <= 1000 && list.every((s) => typeof s === "string") ? list.map((s) => s.slice(0, 2000)) : null);

/**
 * Relay a run process's output to the log one line at a time: each line quoted (so it cannot pass
 * for a line of the server's own), cut to `maxLine` characters, and at most `maxLines` lines.
 */
export function relayOutput(stream, write, { maxLine = 2000, maxLines = 1000 } = {}) {
  let line = "";
  let cutShort = false;
  let lines = 0;
  const emit = () => {
    if (lines < maxLines) write(`run process: ${JSON.stringify(line.toWellFormed())}${cutShort ? " (cut)" : ""}`);
    else if (lines === maxLines) write(`run process: more than ${maxLines} lines; the rest is not logged`);
    lines += 1;
    line = "";
    cutShort = false;
  };
  stream.setEncoding("utf8");
  stream.on("data", (/** @type {string} */ chunk) => {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline === -1 ? chunk.length : newline;
      const room = maxLine - line.length;
      if (end - start > room) cutShort = true;
      if (room > 0) line += chunk.slice(start, start + Math.min(room, end - start));
      if (newline === -1) break;
      emit();
      start = newline + 1;
    }
  });
  stream.on("end", () => {
    if (line || cutShort) emit();
  });
}

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
 * @param {{ timeoutMs?: number, signal?: AbortSignal, killAfterMs?: number, runAs?: { uid: number, gid: number, home?: string } | null, child?: string, log?: Pick<Console, "log" | "error"> }} [options]
 *   `child`: the program to run instead of run-child.js (the tests give their own); `log`: where
 *   the run process's own output goes, quoted and bounded
 * @returns {Promise<{ outcome: string, error: string | null, results: any[], blocked: string[] }>}
 */
export function executeRun(job, { timeoutMs, signal, killAfterMs = 5000, runAs = null, child: program = CHILD, log = console } = {}) {
  return new Promise((resolve) => {
    const results = [];
    const blocked = [];
    let outcome = null;
    let error = null;
    let settled = false;
    const child = fork(program, [], {
      // None of this server's node flags: under `npm run server:dev`, --env-file-if-exists=.env
      // would otherwise load .env (WORKER_TOKEN) into the run's own environment.
      execArgv: [],
      env: childEnv(process.env, runAs?.home ? { HOME: runAs.home } : {}),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
      ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
    });

    if (child.stdout) relayOutput(child.stdout, (line) => log.log(line));
    if (child.stderr) relayOutput(child.stderr, (line) => log.error(line));

    // Once the run is stopped, or the process has said it is done, failed or sent something it
    // should not, nothing more it sends is taken.
    let closed = false;
    const stop = (why) => {
      closed = true;
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

    const malformed = () => {
      error ??= "The run process sent a malformed message.";
      stop("error");
    };
    // One result for each journey and mode of the job, and no other.
    const expected = new Set((job?.journeys ?? []).flatMap((j) => (job?.modes ?? []).map((mode) => `${j.path}\n${mode}`)));
    const taken = new Set();
    child.on("message", (/** @type {any} */ message) => {
      if (closed) return;
      if (message?.type === "result") {
        const refused = blockedOf(message.blocked ?? []);
        if (!isResult(message.result) || !refused) return malformed();
        const key = `${message.result.journey}\n${message.result.mode}`;
        if (!expected.has(key) || taken.has(key)) return malformed();
        taken.add(key);
        results.push(message.result);
        blocked.push(...refused);
      } else if (message?.type === "done") {
        closed = true;
        outcome ??= "done";
      } else if (message?.type === "error") {
        if (typeof message.message !== "string") return malformed();
        closed = true;
        outcome ??= "error";
        error ??= message.message.slice(0, 100_000);
      } else {
        malformed();
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
