// Reading the files a run wrote, which are not trusted. The run's process (and a page that broke
// out of its browser) runs as RUN_AS_UID and can write anything into its reports folder: links
// to files only root can read (the server's own /proc/self/environ, with WORKER_TOKEN), FIFOs,
// files that keep growing. The server runs as root. So:
//
// - stopUserProcesses() first ends every process of that user, so nothing changes the folder
//   while it is read, and nothing survives into the next person's run;
// - listReportFiles() lists the folder without following links, and keeps regular files only;
// - readReportFile() opens each one with O_NOFOLLOW, checks the handle (a regular file, not too
//   large), reads at most the limit plus one byte, and refuses a file whose folder resolves
//   outside the reports folder.

import { constants } from "node:fs";
import { open, readFile, readdir, realpath } from "node:fs/promises";
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
 * Read one file under `root` as UTF-8, or say why not.
 *
 * @param {string} root the reports folder
 * @param {string} path relative to `root`, with "/"
 * @param {number} maxBytes
 * @returns {Promise<{ text: string } | { refused: string }>}
 */
export async function readReportFile(root, path, maxBytes) {
  const full = join(root, ...path.split("/"));
  const [realRoot, realFolder] = await Promise.all([realpath(root), realpath(dirname(full)).catch(() => null)]);
  if (realFolder === null || (realFolder !== realRoot && !realFolder.startsWith(realRoot + sep))) return { refused: "outside the run's folder" };
  let handle;
  try {
    // O_NONBLOCK: a FIFO put in place of a file must not make the open wait for a writer.
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ELOOP") return { refused: "a link" };
    if (error.code === "ENOENT") return { refused: "gone" };
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { refused: "not a regular file" };
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

/**
 * The live processes (not zombies, which can do nothing) whose real, effective, saved or
 * filesystem user is `uid`.
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
    if (/^State:\s+Z/m.test(status)) continue;
    const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (ids && ids.slice(1).some((id) => Number(id) === uid)) pids.push(Number(name));
  }
  return pids;
}

/**
 * End every process of `uid` with SIGKILL, and wait until none is left. Throws if some are still
 * there after `timeoutMs`, so that the caller reads nothing they could still change.
 *
 * @param {number} uid never 0: the server's own user
 * @param {{ procDir?: string, timeoutMs?: number, kill?: (pid: number, signal: string) => unknown }} [options]
 */
export async function stopUserProcesses(uid, { procDir = "/proc", timeoutMs = 5000, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`stopUserProcesses needs a user other than root, not ${uid}`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = await processesOf(uid, procDir);
    if (!pids.length) return;
    if (Date.now() > deadline) throw new Error(`processes of user ${uid} are still running: ${pids.join(", ")}`);
    for (const pid of pids) {
      try {
        kill(pid, "SIGKILL");
      } catch {
        // It ended on its own.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
