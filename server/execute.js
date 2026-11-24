// Start a run's child process and wait for it, with a timeout and a way to abort it.

import { fork, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./run-child.js", import.meta.url));
const PROBE = fileURLToPath(new URL("./sandbox-probe.js", import.meta.url));

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
 * Streams that share one `budget` (stdout and stderr of one run) share the `maxLines`.
 */
export function relayOutput(stream, write, { maxLine = 2000, maxLines = 1000, budget = { lines: 0 } } = {}) {
  let line = "";
  let cutShort = false;
  const emit = () => {
    if (budget.lines < maxLines) write(`run process: ${JSON.stringify(line.toWellFormed())}${cutShort ? " (cut)" : ""}`);
    else if (budget.lines === maxLines) write(`run process: more than ${maxLines} lines; the rest is not logged`);
    budget.lines += 1;
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

/**
 * Start Chromium once with its sandbox, as `runAs` (sandbox-probe.js). Resolves to null if it
 * worked, or to the reason it did not; never rejects. Ended after `timeoutMs`.
 *
 * @param {{ uid: number, gid: number } | null} runAs
 * @param {{ timeoutMs?: number, program?: string, signal?: AbortSignal }} [options] `signal` ends
 *   the probe (the worker stopping)
 * @returns {Promise<string | null>}
 */
export function probeSandbox(runAs, { timeoutMs = 60000, program = PROBE, signal } = {}) {
  return new Promise((resolve) => {
    const child = fork(program, [], {
      execArgv: [],
      env: childEnv(process.env, { HOME: tmpdir() }),
      stdio: ["ignore", "pipe", "ignore", "ipc"],
      ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
    });
    let said = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (/** @type {string} */ chunk) => {
      if (said.length < 1000) said += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const end = () => child.kill("SIGKILL");
    if (signal?.aborted) end();
    else signal?.addEventListener("abort", end, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(`the probe could not start (${error.message})`);
    });
    child.on("exit", (code, killedBy) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", end);
      if (code === 0) return resolve(null);
      resolve(said.trim().split("\n")[0] || `the probe ended (${killedBy ?? `exit code ${code}`})`);
    });
  });
}

/** The longest message a run process may send, in characters; a longer one is malformed. */
export const MAX_MESSAGE = 256 * 1024;

/**
 * Read a run process's messages from `stream`: one JSON value per line. A line longer than `max`
 * (or one still growing past it), or one that is not JSON, calls `onBad` once and ends the
 * reading, so a process cannot make the server hold more than about `max` of its output. Returns
 * `stop()`, which ends the reading without blame (after the process says it is done).
 */
export function readMessages(stream, onMessage, onBad, max = MAX_MESSAGE) {
  let pending = "";
  let bad = false;
  const stop = () => {
    bad = true;
    pending = "";
    stream.destroy();
  };
  const fail = () => {
    stop();
    onBad();
  };
  stream.setEncoding("utf8");
  stream.on("error", () => {});
  stream.on("data", (/** @type {string} */ chunk) => {
    if (bad) return;
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline !== -1; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.length > max) return fail();
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return fail();
      }
      onMessage(message);
      if (bad) return;
    }
    if (pending.length > max) fail();
  });
  return stop;
}

export function childEnv(env = process.env, overrides = {}) {
  const passed = Object.fromEntries(Object.entries(env).filter(([name, value]) => passes(name) && value !== undefined));
  return { ...passed, ...overrides };
}

/**
 * Run `job` (see run-child.js) in a child process. Resolves, never rejects, with
 * `{ outcome: "done" | "timeout" | "aborted" | "error", error, results, blocked }`, where
 * `results` holds every journey and mode that finished, even after a timeout: results already on
 * their way when it passes are still taken, until the process has ended.
 *
 * `runAs: { uid, gid, home }` starts the process as that user, so that a page that breaks out of
 * the browser cannot read this server's environment (its Supabase keys) through /proc. This
 * server must then run as root, as it does in the Docker image.
 *
 * @param {object} job
 * @param {{ timeoutMs?: number, signal?: AbortSignal, killAfterMs?: number, runAs?: { uid: number, gid: number, home?: string } | null, child?: string, log?: Pick<Console, "log" | "error">, onEvent?: (event: { kind: string, journey: string, mode: string, step?: string, n?: number, status?: string }) => void }} [options]
 *   `child`: the program to run instead of run-child.js (the tests give their own); `log`: where
 *   the run process's own output goes, quoted and bounded; `onEvent`: told, as the run goes, of
 *   { kind: "start", journey, mode }, { kind: "step", journey, mode, step, n } and
 *   { kind: "result", journey, mode, status }, each checked first (the run's page shows them)
 * @returns {Promise<{ outcome: string, error: string | null, results: any[], blocked: string[] }>}
 */
export function executeRun(job, { timeoutMs, signal, killAfterMs = 5000, runAs = null, child: program = CHILD, log = console, onEvent = () => {} } = {}) {
  return new Promise((resolve) => {
    const results = [];
    const blocked = [];
    let outcome = null;
    let error = null;
    let settled = false;
    // Started with node and the program only, so none of this server's node flags: under
    // `npm run server:dev`, --env-file-if-exists=.env would otherwise load .env (WORKER_TOKEN)
    // into the run's own environment. No IPC channel, whose messages have no size limit: the job
    // goes in on stdin, and the messages come back on fd 3, one JSON line each (readMessages).
    const child = spawn(process.execPath, [program], {
      env: childEnv(process.env, runAs?.home ? { HOME: runAs.home } : {}),
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      ...(runAs ? { uid: runAs.uid, gid: runAs.gid } : {}),
    });

    // One budget of log lines for stdout and stderr together.
    const budget = { lines: 0 };
    if (child.stdout) relayOutput(child.stdout, (line) => log.log(line), { budget });
    if (child.stderr) relayOutput(child.stderr, (line) => log.error(line), { budget });

    // Once the process has said it is done or failed, or sent something it should not, nothing
    // more it sends is taken, or read. After a timeout or an abort, results already on their way
    // are still taken (each once, for the job's own journeys and modes) until it has ended.
    let closed = false;
    let stopReading = () => {};
    const close = () => {
      closed = true;
      stopReading();
    };
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

    const malformed = () => {
      error ??= "The run process sent a malformed message.";
      close();
      stop("error");
    };
    // One result for each journey and mode of the job, and no other.
    const expected = new Set((job?.journeys ?? []).flatMap((j) => (job?.modes ?? []).map((mode) => `${j.path}\n${mode}`)));
    const taken = new Set();
    const onMessage = (/** @type {any} */ message) => {
      if (closed) return;
      if (message?.type === "result") {
        const refused = blockedOf(message.blocked ?? []);
        if (!isResult(message.result) || !refused) return malformed();
        const key = `${message.result.journey}\n${message.result.mode}`;
        if (!expected.has(key) || taken.has(key)) return malformed();
        taken.add(key);
        // Only the fields the worker uses: anything else the process added is not kept.
        const r = message.result;
        results.push({ journey: r.journey, name: r.name, mode: r.mode, status: r.status, error: r.error, checks_total: r.checks_total, checks_passed: r.checks_passed, errors: r.errors, warnings: r.warnings, report_base: r.report_base });
        blocked.push(...refused);
        onEvent({ kind: "result", journey: r.journey, mode: r.mode, status: r.status });
      } else if (message?.type === "progress") {
        // Where the run is: for one of the job's journeys and modes, not yet finished; a step is
        // short text and a count. Nothing else is passed on.
        const key = `${message.journey}\n${message.mode}`;
        if (!expected.has(key) || taken.has(key)) return malformed();
        if (message.step === undefined) return onEvent({ kind: "start", journey: message.journey, mode: message.mode });
        if (!isText(message.step, 200) || !isCount(message.n)) return malformed();
        onEvent({ kind: "step", journey: message.journey, mode: message.mode, step: message.step.toWellFormed(), n: message.n });
      } else if (message?.type === "done") {
        close();
        outcome ??= "done";
      } else if (message?.type === "error") {
        if (typeof message.message !== "string") return malformed();
        close();
        outcome ??= "error";
        error ??= message.message.slice(0, 100_000);
      } else {
        malformed();
      }
    };
    const messages = /** @type {import("node:stream").Readable} */ (child.stdio[3]);
    if (messages) stopReading = readMessages(messages, onMessage, malformed);
    child.on("error", (spawnError) => {
      outcome ??= "error";
      error ??= `Could not start the run process: ${spawnError.message}`;
      settle();
    });
    // Settled once its pipes are drained ("close"), so no message written just before it exited is
    // lost; or a moment after "exit", if something it started still holds a pipe open.
    let ended = null;
    const end = () => {
      if (!outcome) {
        outcome = "error";
        error = `The run process stopped unexpectedly (${ended}).`;
      }
      settle();
    };
    child.on("exit", (code, signalName) => {
      ended = signalName ?? `exit code ${code}`;
      setTimeout(end, 2000).unref();
    });
    child.on("close", (code, signalName) => {
      ended ??= signalName ?? `exit code ${code}`;
      end();
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(job));
  });
}
