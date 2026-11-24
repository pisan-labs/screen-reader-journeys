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

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { listReportFiles, readReportFile } from "./reports.js";

/** Remove everything inside each folder (not the folder itself), as this process's user. */
export async function clearFolders(dirs) {
  const left = [];
  for (const dir of dirs) {
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

if (process.send && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on("message", async (message) => {
    const { id, request } = message ?? {};
    try {
      process.send({ id, ok: true, value: await handle(request) });
    } catch (error) {
      process.send({ id, ok: false, error: String(error?.message ?? error) });
    }
  });
  process.on("disconnect", () => process.exit(0));
}
