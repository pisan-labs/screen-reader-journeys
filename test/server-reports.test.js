// Reading the files a run wrote (server/reports.js): links, FIFOs, large files and folders
// swapped for links are never read, and every process of the run's user is stopped first.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkReportsFolder, listReportFiles, processesOf, readReportFile, recordReportsFolder, stopUserProcesses } from "../server/reports.js";

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

  it("refuses a hard link, and a file of another user", async () => {
    await link(join(outside, "secret.txt"), join(reports, "hard.txt"));
    try {
      assert.deepEqual(await readReportFile(reports, "hard.txt", 100), { refused: "not the run's own file" });
    } finally {
      await rm(join(reports, "hard.txt"));
    }
    assert.deepEqual(await readReportFile(reports, "summary.md", 100, { uid: process.getuid() + 1 }), { refused: "not the run's own file" });
    assert.deepEqual(await readReportFile(reports, "summary.md", 100, { uid: process.getuid() }), { text: "# Summary" });
  });

  it("checks against the folder's real path as recorded, not as it resolves now", async () => {
    // As if the reports folder were now a link elsewhere: the recorded root no longer matches.
    assert.deepEqual(await readReportFile(outside, "secret.txt", 100, { realRoot: reports }), { refused: "outside the run's folder" });
  });
});

describe("the reports folder itself", () => {
  it("is refused once the run has replaced it, even with a link to a real folder", async () => {
    const folder = join(base, "run-reports");
    await mkdir(folder);
    const recorded = await recordReportsFolder(folder);
    await checkReportsFolder(recorded);
    await rename(folder, `${folder}.old`);
    await symlink(outside, folder);
    await assert.rejects(checkReportsFolder(recorded), /The run replaced its reports folder/);
    await rm(folder);
    await mkdir(folder); // a new real folder in its place: another inode
    await assert.rejects(checkReportsFolder(recorded), /The run replaced its reports folder/);
  });
});

describe("stopping the run's processes", () => {
  /**
   * A fake /proc: one folder per pid with a status file and, when given, task/<tid>/status for its
   * threads. "Killing" a user removes their pids.
   */
  async function fakeProc(entries) {
    const dir = await mkdtemp(join(tmpdir(), "srj-proc-"));
    const status = (uid, state) => `Name:\tx\nState:\t${state}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
    for (const [pid, uid, state = "S (sleeping)", tasks = null] of entries) {
      await mkdir(join(dir, String(pid)));
      await writeFile(join(dir, String(pid), "status"), status(uid, state));
      for (const [tid, taskState] of tasks ?? []) {
        await mkdir(join(dir, String(pid), "task", String(tid)), { recursive: true });
        await writeFile(join(dir, String(pid), "task", String(tid), "status"), status(uid, taskState));
      }
    }
    await mkdir(join(dir, "self"));
    return dir;
  }
  const killer = (proc, uids, calls = []) => async (uid, gid) => {
    calls.push([uid, gid]);
    for (const [pid, owner] of uids) if (owner === uid) execFileSync("rm", ["-rf", join(proc, String(pid))]);
  };
  /** Never signal a real process from a fake /proc's pids: record them instead. */
  const fakeKill = (killed = []) => (pid, signal) => killed.push([pid, signal]);

  it("finds the live processes of a user, including one whose main thread has exited", async () => {
    const proc = await fakeProc([
      [11, 10001],
      [12, 0],
      [13, 10001, "Z (zombie)"],
      [14, 10001],
      // The leader exited, another thread runs: "Z" in its own status, but alive.
      [16, 10001, "Z (zombie)", [[16, "Z (zombie)"], [17, "S (sleeping)"]]],
      // Every thread dead.
      [18, 10001, "Z (zombie)", [[18, "Z (zombie)"], [19, "X (dead)"]]],
    ]);
    await mkdir(join(proc, "15")); // ended while we looked: no status file
    assert.deepEqual((await processesOf(10001, proc)).sort(), [11, 14, 16]);
    await rm(proc, { recursive: true });
  });

  it("kills them all by user, as that user, and waits until none is left", async () => {
    const entries = [[21, 10001], [22, 10001, "Z (zombie)", [[22, "Z (zombie)"], [23, "R (running)"]]], [24, 0]];
    const proc = await fakeProc(entries);
    const calls = [];
    const killed = [];
    await stopUserProcesses(10001, { gid: 10002, procDir: proc, killAll: killer(proc, entries, calls), kill: fakeKill(killed) });
    assert.deepEqual(calls, [[10001, 10002]], "one kill for the whole user");
    assert.deepEqual(killed, [[21, "SIGKILL"], [22, "SIGKILL"]], "and each listed pid from root");
    assert.deepEqual(await processesOf(10001, proc), []);
    assert.deepEqual(await processesOf(0, proc), [24], "root's process is left alone");
    await rm(proc, { recursive: true });
  });

  it("gives up with an error when one will not end, and never acts for root", async () => {
    const proc = await fakeProc([[31, 10001]]);
    await assert.rejects(stopUserProcesses(10001, { procDir: proc, timeoutMs: 100, killAll: async () => {}, kill: fakeKill() }), /processes of user 10001 are still running: 31/);
    await assert.rejects(stopUserProcesses(0, { procDir: proc }), /a user other than root/);
    await rm(proc, { recursive: true });
  });

  it("still throws at its deadline when the helper never comes back (R2.3-1)", async () => {
    const proc = await fakeProc([[41, 10001]]);
    const started = Date.now();
    await assert.rejects(
      stopUserProcesses(10001, { procDir: proc, timeoutMs: 200, killAll: () => new Promise(() => {}), kill: fakeKill() }),
      /processes of user 10001 are still running: 41/
    );
    assert.ok(Date.now() - started < 5000, "it did not wait on the helper");
    await rm(proc, { recursive: true });
  });

  const root = process.getuid?.() === 0;
  const live = async (pid) => (await processesOf(10001)).includes(pid);
  const until = async (check) => {
    for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 20));
  };

  it("ends a real process of that user, even one in its own session", { skip: !root && "needs root, as in the Docker image" }, async () => {
    const child = spawn("sleep", ["60"], { uid: 10001, gid: 10001, detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
    await until(() => live(child.pid));
    assert.ok(await live(child.pid), "the process started");
    await stopUserProcesses(10001);
    assert.deepEqual(await processesOf(10001), []);
    assert.equal(await exited, "SIGKILL");
  });

  let python = false;
  try {
    execFileSync("python3", ["-c", "import ctypes, threading"], { stdio: "ignore" });
    python = true;
  } catch {
    // No python3 here: the next test cannot make a process whose main thread exits.
  }
  it("ends a real process whose main thread has exited while another thread runs", { skip: (!root && "needs root, as in the Docker image") || (!python && "needs python3") }, async () => {
    const beat = join(base, "heartbeat");
    // The main thread calls pthread_exit; the other thread keeps writing a heartbeat.
    const script = `import ctypes, threading, time\ndef run():\n    n = 0\n    while True:\n        n += 1\n        open(${JSON.stringify(beat)}, "w").write(str(n))\n        time.sleep(0.02)\nthreading.Thread(target=run).start()\ntime.sleep(0.2)\nctypes.CDLL(None).pthread_exit(None)\n`;
    await writeFile(join(base, "leader.py"), script);
    execFileSync("chmod", ["a+rx", base, join(base, "leader.py")]);
    execFileSync("chmod", ["a+w", base]);
    const child = spawn("python3", [join(base, "leader.py")], { uid: 10001, gid: 10001, detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal)));
    const { readFile } = await import("node:fs/promises");
    const leaderGone = async () => /^State:\s+Z/m.test(await readFile(`/proc/${child.pid}/status`, "utf8").catch(() => ""));
    const beatNow = () => readFile(beat, "utf8").catch(() => "");
    await until(leaderGone);
    assert.ok(await leaderGone(), "the main thread exited");
    // Before the stop: the other thread is really running, so its heartbeat moves.
    let first = "";
    await until(async () => (first = await beatNow()) !== "");
    await until(async () => !["", first].includes(await beatNow()));
    assert.notEqual(await beatNow(), first, "its other thread is running");
    assert.ok(await live(child.pid), "it is still alive, by its other thread");
    await stopUserProcesses(10001);
    assert.deepEqual(await processesOf(10001), []);
    // The kernel says so too: the whole process ended, by SIGKILL.
    assert.equal(await exited, "SIGKILL");
  });

  /**
   * A process of the run's user that sends `signal` to every other process of that user it sees,
   * as soon as it sees it: the kill helper included, since it runs as that user.
   */
  async function hunter(signal) {
    const script = join(base, `hunter-${signal}.cjs`);
    await writeFile(
      script,
      `const fs = require("fs");
const me = process.pid;
const seen = new Set();
fs.writeFileSync(${JSON.stringify(join(base, `hunting-${signal}`))}, "yes");
for (;;) {
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\\d+$/.test(name) || Number(name) === me || seen.has(name)) continue;
    try {
      if (/^Uid:\\s+10001\\b/m.test(fs.readFileSync("/proc/" + name + "/status", "utf8"))) {
        seen.add(name);
        process.kill(Number(name), ${JSON.stringify(signal)});
      }
    } catch {}
  }
}
`
    );
    execFileSync("chmod", ["a+rx", base, script]);
    execFileSync("chmod", ["a+w", base]);
    const child = spawn(process.execPath, [script], { uid: 10001, gid: 10001, detached: true, stdio: "ignore" });
    const exited = new Promise((resolve) => child.on("exit", (code, sig) => resolve(sig)));
    const { readFile } = await import("node:fs/promises");
    await until(async () => (await readFile(join(base, `hunting-${signal}`), "utf8").catch(() => "")) === "yes");
    return { child, exited };
  }

  for (const signal of ["SIGSTOP", "SIGKILL"]) {
    it(`ends a process that sends ${signal} to the kill helper, and returns (R2.3-1)`, { skip: !root && "needs root, as in the Docker image" }, async () => {
      const { child, exited } = await hunter(signal);
      assert.ok(await live(child.pid), "the hunter is running");
      await stopUserProcesses(10001);
      assert.deepEqual(await processesOf(10001), []);
      assert.equal(await exited, "SIGKILL");
    });
  }
});
