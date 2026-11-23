// Reading the files a run wrote (server/reports.js): links, FIFOs, large files and folders
// swapped for links are never read, and every process of the run's user is stopped first.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { listReportFiles, processesOf, readReportFile, stopUserProcesses } from "../server/reports.js";

const MARKER = "SECRET-MARKER-the-server-must-never-read-this";
let base;
let reports;
let outside;

before(async () => {
  base = await mkdtemp(join(tmpdir(), "srj-reports-"));
  reports = join(base, "reports");
  outside = join(base, "outside");
  await mkdir(join(reports, "sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secret.txt"), MARKER);
  await writeFile(join(reports, "summary.md"), "# Summary");
  await writeFile(join(reports, "sub", "deep.md"), "deep");
  await symlink(join(outside, "secret.txt"), join(reports, "leak.txt"));
  await symlink(outside, join(reports, "folder-link"));
  execFileSync("mkfifo", [join(reports, "pipe.md")]);
});
after(() => rm(base, { recursive: true, force: true }));

describe("listing a run's reports", () => {
  it("keeps regular files only, and does not follow a link to a folder", async () => {
    assert.deepEqual(await listReportFiles(reports), { files: ["sub/deep.md", "summary.md"], others: ["folder-link", "leak.txt", "pipe.md"] });
  });
});

describe("reading one report", () => {
  it("reads a regular file", async () => {
    assert.deepEqual(await readReportFile(reports, "summary.md", 100), { text: "# Summary" });
    assert.deepEqual(await readReportFile(reports, "sub/deep.md", 100), { text: "deep" });
  });

  it("refuses a link, a FIFO, a file that is gone, and a file over the limit", async () => {
    assert.deepEqual(await readReportFile(reports, "leak.txt", 100), { refused: "a link" });
    assert.deepEqual(await readReportFile(reports, "pipe.md", 100), { refused: "not a regular file" });
    assert.deepEqual(await readReportFile(reports, "gone.md", 100), { refused: "gone" });
    assert.deepEqual(await readReportFile(reports, "summary.md", 5), { refused: "too large" });
  });

  it("refuses a file whose folder resolves outside the reports folder", async () => {
    assert.deepEqual(await readReportFile(reports, "folder-link/secret.txt", 100), { refused: "outside the run's folder" });
  });
});

describe("stopping the run's processes", () => {
  /** A fake /proc: one folder per pid with a status file. Killing a pid removes its folder. */
  async function fakeProc(entries) {
    const dir = await mkdtemp(join(tmpdir(), "srj-proc-"));
    for (const [pid, uid, state = "S (sleeping)"] of entries) {
      await mkdir(join(dir, String(pid)));
      await writeFile(join(dir, String(pid), "status"), `Name:\tx\nState:\t${state}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    }
    await mkdir(join(dir, "self"));
    return dir;
  }

  it("finds the live processes of a user, not zombies or other users", async () => {
    const proc = await fakeProc([[11, 10001], [12, 0], [13, 10001, "Z (zombie)"], [14, 10001]]);
    await mkdir(join(proc, "15")); // ended while we looked: no status file
    assert.deepEqual((await processesOf(10001, proc)).sort(), [11, 14]);
    await rm(proc, { recursive: true });
  });

  it("kills them and waits until none is left", async () => {
    const proc = await fakeProc([[21, 10001], [22, 10001], [23, 0]]);
    const killed = [];
    await stopUserProcesses(10001, {
      procDir: proc,
      kill: (pid, signal) => {
        killed.push([pid, signal]);
        execFileSync("rm", ["-rf", join(proc, String(pid))]);
      },
    });
    assert.deepEqual(killed.sort(), [[21, "SIGKILL"], [22, "SIGKILL"]]);
    await rm(proc, { recursive: true });
  });

  it("gives up with an error when one will not end, and never acts for root", async () => {
    const proc = await fakeProc([[31, 10001]]);
    await assert.rejects(stopUserProcesses(10001, { procDir: proc, timeoutMs: 100, kill: () => {} }), /processes of user 10001 are still running: 31/);
    await assert.rejects(stopUserProcesses(0, { procDir: proc }), /a user other than root/);
    await rm(proc, { recursive: true });
  });

  const root = process.getuid?.() === 0;
  it("ends a real process of that user, even one in its own session", { skip: !root && "needs root, as in the Docker image" }, async () => {
    const child = spawn("sleep", ["60"], { uid: 10001, gid: 10001, detached: true, stdio: "ignore" });
    child.unref();
    for (let i = 0; i < 100 && !(await processesOf(10001)).includes(child.pid); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok((await processesOf(10001)).includes(child.pid), "the process started");
    await stopUserProcesses(10001);
    assert.deepEqual(await processesOf(10001), []);
  });
});
