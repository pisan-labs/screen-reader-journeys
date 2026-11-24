// Reading the files a run wrote, which are not trusted. The run's process (and a page that broke
// out of its browser) runs as RUN_AS_UID and can write anything into its reports folder: links
// to files only root can read (the server's own /proc/self/environ, with WORKER_TOKEN), hard
// links, FIFOs, files that keep growing. The server runs as root. So:
//
// - the worker keeps the run's work folder root-owned, so the run cannot swap its reports folder
//   for a link, and checkReportsFolder() checks that it is still the folder the worker made;
// - stopUserProcesses() first ends every process of that user, and returns only once a kill(-1)
//   as that user has run to the end and no process of the user is left, so nothing changes the
//   folder while it is read and nothing survives into the next person's run;
// - the reading and the deleting happen in a child that runs as that user (report-child.js,
//   startReportChild()), so whatever a missed process does, they reach only what that user may;
// - listReportFiles() lists the folder without following links, and keeps regular files only;
// - readReportFile() opens each one with O_NOFOLLOW, checks the handle (a regular file owned by
//   the run's user, with one link, not too large), reads at most the limit plus one byte, and
//   refuses a file whose folder resolves outside the reports folder made for the run.

import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

/**
 * The regular files under `dir`, and everything else there that is not a folder (links, FIFOs,
 * sockets), as paths relative to `dir` with "/". Links to folders are not followed.
 *
 * @param {string} dir
 * @returns {Promise<{ files: string[], others: string[] }>}
 */
export async function listReportFiles(dir) {
  const files = [];
  const others = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = relative(dir, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join("/");
    if (entry.isFile()) files.push(path);
    else if (!entry.isDirectory()) others.push(path);
  }
  return { files: files.sort(), others: others.sort() };
}

/**
 * What the worker records about a run's reports folder when it makes it, to check later that the
 * run has not replaced it.
 *
 * @typedef {{ path: string, real: string, dev: number, ino: number, uid: number }} ReportsFolder
 */

/**
 * @param {string} path the folder just made for the run's reports
 * @returns {Promise<ReportsFolder>}
 */
export async function recordReportsFolder(path) {
  const info = await lstat(path);
  return { path, real: await realpath(path), dev: info.dev, ino: info.ino, uid: info.uid };
}

/**
 * Throws unless `folder.path` is still the same real folder (not a link, the same inode, the same
 * owner) as when it was recorded.
 *
 * @param {ReportsFolder} folder
 */
export async function checkReportsFolder(folder) {
  const info = await lstat(folder.path);
  if (info.isSymbolicLink() || !info.isDirectory() || info.dev !== folder.dev || info.ino !== folder.ino || info.uid !== folder.uid) {
    throw new Error("The run replaced its reports folder.");
  }
}

/**
 * Read one file under `root` as UTF-8, or say why not.
 *
 * @param {string} root the reports folder
 * @param {string} path relative to `root`, with "/"
 * @param {number} maxBytes
 * @param {{ realRoot?: string, uid?: number }} [options] `realRoot`: the folder's real path as
 *   recorded when it was made (not resolved again now); `uid`: the user every file must belong to
 * @returns {Promise<{ text: string } | { refused: string }>}
 */
export async function readReportFile(root, path, maxBytes, { realRoot, uid } = {}) {
  const full = join(root, ...path.split("/"));
  const [base, realFolder] = await Promise.all([realRoot ?? realpath(root), realpath(dirname(full)).catch(() => null)]);
  if (realFolder === null || (realFolder !== base && !realFolder.startsWith(base + sep))) return { refused: "outside the run's folder" };
  let handle;
  try {
    // O_NONBLOCK: a FIFO put in place of a file must not make the open wait for a writer.
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ELOOP") return { refused: "a link" };
    if (error.code === "ENOENT") return { refused: "gone" };
    if (error.code === "EACCES") return { refused: "not readable" };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { refused: "not a regular file" };
    // A hard link to a file the run does not own (where the host allows one) is not its report.
    if (info.nlink !== 1 || (uid !== undefined && info.uid !== uid)) return { refused: "not the run's own file" };
    if (info.size > maxBytes) return { refused: "too large" };
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { refused: "too large" };
    return { text: buffer.subarray(0, length).toString("utf8") };
  } finally {
    await handle.close();
  }
}

const DEAD = /^State:\s+[ZX]/m;

/**
 * The processes whose real, effective, saved or filesystem user is `uid` and that still have a
 * live thread. A process whose main thread has exited shows "Z" in its own status while its other
 * threads run, so every thread (/proc/<pid>/task/*) is looked at, not only the first.
 *
 * @param {number} uid
 * @param {string} [procDir]
 * @returns {Promise<number[]>}
 */
export async function processesOf(uid, procDir = "/proc") {
  const pids = [];
  for (const name of await readdir(procDir)) {
    if (!/^\d+$/.test(name)) continue;
    let status;
    try {
      status = await readFile(join(procDir, name, "status"), "utf8");
    } catch {
      continue; // it ended while we looked
    }
    const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (!ids || !ids.slice(1).some((id) => Number(id) === uid)) continue;
    let live = !DEAD.test(status);
    try {
      for (const task of await readdir(join(procDir, name, "task"))) {
        const taskStatus = await readFile(join(procDir, name, "task", task, "status"), "utf8").catch(() => "State:\tX (dead)");
        if (!DEAD.test(taskStatus)) live = true;
      }
    } catch {
      // No task folder (it ended, or a /proc without one): the process's own state decides.
    }
    if (live) pids.push(Number(name));
  }
  return pids;
}

/**
 * The helper's program: one kill(-1, SIGKILL), then exit 0 (ESRCH, nothing it may signal, is also
 * success). The kernel sends it to every process of this user in one pass over the task list,
 * under its lock, and a fork in progress fails once its parent has a fatal signal pending, so a
 * process that forks to get away cannot outrun it. A helper that exits 0 by itself therefore
 * proves the pass ran to the end. (Its answer cannot say whether anything was left: kill(-1)
 * succeeds whenever any other process exists, even one it may not signal.) Any other error
 * exits 2.
 */
const KILL_ALL = `try { process.kill(-1, "SIGKILL"); process.exit(0); } catch (e) { process.exit(e && e.code === "ESRCH" ? 0 : 2); }`;

/**
 * Kill every process of `uid`, from a short-lived helper that runs as that user (kill(-1) picks
 * them by user). Resolves to true only when the helper exited by itself with code 0, so its one
 * kill(-1) ran to the end; false otherwise.
 *
 * Running as that user, the helper can itself be stopped or killed by one of the processes it is
 * meant to end. So root ends it after `limitMs` whatever state it is in (then false), and the
 * caller also kills every listed pid from root, which those processes cannot block.
 *
 * @param {number} uid
 * @param {number} gid
 * @param {{ limitMs?: number }} [options]
 * @returns {Promise<boolean>}
 */
export function killAllOf(uid, gid, { limitMs = 1000 } = {}) {
  return new Promise((resolve) => {
    const helper = spawn(process.execPath, ["-e", KILL_ALL], { uid, gid, env: {}, cwd: "/", stdio: "ignore" });
    const timer = setTimeout(() => helper.kill("SIGKILL"), limitMs);
    const done = (code, signal) => {
      clearTimeout(timer);
      resolve(code === 0 && !signal);
    };
    helper.on("exit", done);
    helper.on("error", () => done(null, "error"));
  });
}

/** SIGKILL each pid from here (root): a process cannot block or catch it. */
function killEach(pids, kill) {
  for (const pid of pids) {
    try {
      kill(pid, "SIGKILL");
    } catch {
      // It ended on its own.
    }
  }
}

/**
 * End every process of `uid`. Each pass kills every listed pid from root, then everything of the
 * user from the helper. It returns only after a pass whose helper completed (killAll resolved
 * true) and a scan after it that finds no live process: one empty scan is no proof, since a
 * process that forks and exits fast enough is never in it. Throws at `timeoutMs` otherwise, so
 * that the caller reads and deletes nothing they could still change.
 *
 * @param {number} uid never 0: the server's own user
 * @param {{
 *   gid?: number,
 *   procDir?: string,
 *   timeoutMs?: number,
 *   killAll?: (uid: number, gid: number) => Promise<boolean>,
 *   kill?: (pid: number, signal: string) => unknown,
 * }} [options]
 */
export async function stopUserProcesses(uid, { gid = uid, procDir = "/proc", timeoutMs = 10000, killAll = killAllOf, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`stopUserProcesses needs a user other than root, not ${uid}`);
  const deadline = Date.now() + timeoutMs;
  let proven = false;
  for (;;) {
    const pids = await processesOf(uid, procDir);
    if (!pids.length && proven) return;
    if (Date.now() > deadline) {
      throw new Error(pids.length ? `processes of user ${uid} are still running: ${pids.join(", ")}` : `could not confirm that every process of user ${uid} ended`);
    }
    killEach(pids, kill);
    // A helper that never comes back cannot hold the stop past its deadline.
    let timer;
    const outOfTime = new Promise((resolve) => (timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))));
    proven = (await Promise.race([killAll(uid, gid), outOfTime])) === true;
    clearTimeout(timer);
    if (!proven) await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const REPORT_CHILD = fileURLToPath(new URL("./report-child.js", import.meta.url));

/**
 * A child process for report-child.js's requests, run as `asUser` (the run's user), or as this
 * process's user when `asUser` is null. Each request is answered within `limitMs`, or the child
 * is killed and the request fails. close() ends it.
 *
 * @param {{ uid: number, gid: number } | null} asUser
 * @param {{ limitMs?: number }} [options]
 */
export function startReportChild(asUser, { limitMs = 30000 } = {}) {
  const child = fork(REPORT_CHILD, [], {
    ...(asUser ? { uid: asUser.uid, gid: asUser.gid } : {}),
    env: {},
    cwd: "/",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  let next = 0;
  /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }>} */
  const waiting = new Map();
  const failAll = (error) => {
    for (const { reject, timer } of waiting.values()) {
      clearTimeout(timer);
      reject(error);
    }
    waiting.clear();
  };
  child.on("message", (/** @type {any} */ message) => {
    const entry = waiting.get(message?.id);
    if (!entry) return;
    waiting.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok) entry.resolve(message.value);
    else entry.reject(new Error(`report child: ${message.error}`));
  });
  child.on("exit", (code, signal) => failAll(new Error(`report child ended (${signal ?? code})`)));
  child.on("error", (error) => failAll(error));
  return {
    /** @param {object} request */
    call(request) {
      return new Promise((resolve, reject) => {
        const id = (next += 1);
        const timer = setTimeout(() => {
          waiting.delete(id);
          child.kill("SIGKILL");
          reject(new Error(`report child: no answer within ${limitMs} ms`));
        }, limitMs);
        waiting.set(id, { resolve, reject, timer });
        child.send({ id, request }, (error) => {
          if (!error) return;
          waiting.delete(id);
          clearTimeout(timer);
          reject(error);
        });
      });
    },
    close() {
      if (child.connected) child.disconnect();
      child.kill("SIGKILL");
    },
  };
}
