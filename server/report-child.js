// The part of report handling that touches the run's files, run as the run's own user
// (RUN_AS_UID) in a short child process. The server, which is root, sends it requests over IPC:
//
//   { op: "list", dir }                               -> { files, others }
//   { op: "read", dir, path, maxBytes, realRoot, uid } -> { text } | { refused }
//   { op: "clear", dirs }                             -> { left: [path] } (what it could not remove)
//
// Whatever a process of that user does to the folders meanwhile (links swapped in, files
// changed), this child can only read or delete what that user may anyway. The server never
// reads or deletes the run's files as root.

import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listReportFiles, readReportFile } from "./reports.js";

/**
 * Make a folder of this user's, and every folder below it, writable and searchable by its owner,
 * so that rm can empty it (a folder the run made read-only would otherwise stay). Links are not
 * followed, and what this user does not own is left as it is.
 */
async function makeRemovable(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return;
  await chmod(path, 0o700).catch(() => {});
  for (const name of await readdir(path).catch(() => [])) await makeRemovable(join(path, name));
}

/**
 * Remove everything inside each folder (not the folder itself), as this process's user. The
 * folder and everything below it are made writable first, the folder itself included: the run
 * may have made reports/ or home/ read-only.
 */
export async function clearFolders(dirs) {
  const left = [];
  for (const dir of dirs) {
    await makeRemovable(dir);
    let names = [];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (error.code !== "ENOENT") left.push(dir); // not ours to list (another user's): left alone
      continue;
    }
    for (const name of names) {
      try {
        await rm(join(dir, name), { recursive: true, force: true });
      } catch {
        left.push(join(dir, name));
      }
    }
  }
  return { left };
}

/** Answer one request. */
export async function handle(request) {
  switch (request?.op) {
    case "list":
      return listReportFiles(request.dir);
    case "read":
      return readReportFile(request.dir, request.path, request.maxBytes, { realRoot: request.realRoot, uid: request.uid });
    case "clear":
      return clearFolders(request.dirs ?? []);
    default:
      throw new Error(`unknown request ${JSON.stringify(request?.op)}`);
  }
}

/**
 * Answer the server's requests on `channel` (this process's IPC channel) until it disconnects,
 * then exit. Each answer carries the request's id; an error is sent back as an error.
 *
 * @param {{ on: (event: string, listener: (...args: any[]) => void) => unknown, send?: (message: any) => unknown }} channel
 * @param {(code: number) => void} [exit]
 */
export function serve(channel, exit = (code) => process.exit(code)) {
  channel.on("message", async (/** @type {any} */ message) => {
    const { id, request } = message ?? {};
    try {
      channel.send?.({ id, ok: true, value: await handle(request) });
    } catch (error) {
      channel.send?.({ id, ok: false, error: String(error?.message ?? error) });
    }
  });
  channel.on("disconnect", () => exit(0));
}

if (process.send && import.meta.url === pathToFileURL(process.argv[1]).href) serve(process);
