// The hosted server's worker, with a fake Supabase client. The end-to-end tests run real
// journeys in Chromium against local fixture sites, with the allowlist set to 127.0.0.1.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCatalog, REPO_ROOT } from "../server/catalog.js";
import { MAX_BLOCKED, MAX_MESSAGE, childEnv, executeRun, probeSandbox } from "../server/execute.js";
import { timeoutFetch } from "../server/timeout-fetch.js";
import { parseAllowedHosts } from "../server/hosts.js";
import { MAX_REPORT_BYTES, MAX_REPORT_FILES, createWorker, summarizeRun } from "../server/worker.js";
import { workerDb } from "../server/worker-db.js";
import { clearFolders, handle } from "../server/report-child.js";
import { WORKER_TOKEN, fakeSupabase } from "./helpers/fake-supabase.js";
import { serve } from "./server.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
const BASIC = "test/fixtures/basic.journey.js";
const EGRESS = "test/fixtures/egress.journey.js";
const HANG = "test/fixtures/hang.journey.js";
const USER = "00000000-0000-4000-8000-00000000000a";
const quiet = { log() {}, error() {} };

let catalog;
before(async () => {
  catalog = await loadCatalog({ root: REPO_ROOT, dirs: ["test/fixtures"] });
});

const configFor = (hosts, overrides = {}) => ({
  allowedTargetHosts: hosts,
  targetRules: parseAllowedHosts(hosts),
  runTimeoutMs: 60000,
  pollIntervalMs: 50,
  chromiumSandbox: false,
  ...overrides,
});
const queued = (fields) => ({ id: randomUUID(), user_id: USER, status: "queued", modes: ["walker"], ...fields });
/** The worker's database access: the fake's worker_* functions, with the right token. */
const dbOf = (fake, token = WORKER_TOKEN) => workerDb(fake, token);

describe("worker, end to end", () => {
  let site;
  before(async () => {
    site = await serve(fixtures);
  });
  after(() => site.close());

  it("claims a run, runs it, saves the reports and records the results", async () => {
    const run = queued({ base_url: `${site.url}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const worker = createWorker({ db: dbOf(fake), catalog, config: configFor(new URL(site.url).host), log: quiet });

    assert.equal(await worker.tick(), true);
    const saved = fake.run(run.id);
    assert.equal(saved.status, "done", saved.error);
    assert.ok(saved.started_at && saved.finished_at);
    assert.equal(saved.error, null);

    assert.equal(fake.tables.run_results.length, 1);
    const [result] = fake.tables.run_results;
    assert.equal(result.run_id, run.id);
    assert.equal(result.journey, BASIC);
    assert.equal(result.mode, "walker");
    assert.equal(result.status, "pass");
    assert.equal(result.checks_passed, result.checks_total);
    assert.ok(result.checks_total >= 2);
    assert.ok(result.errors >= 2, "basic.html has a nameless button and a button inside aria-hidden");
    assert.ok(result.warnings >= 1);
    assert.equal(result.report_path, "basic-test-page.walker.md");
    assert.equal(result.user_id, USER, "the result belongs to the run's owner");

    const saved_reports = fake.tables.run_reports.map((r) => r.path).sort();
    assert.deepEqual(saved_reports, ["basic-test-page.walker.html", "basic-test-page.walker.json", "basic-test-page.walker.md", "summary.html", "summary.md"]);
    assert.ok(fake.tables.run_reports.every((r) => r.run_id === run.id && r.user_id === USER));
    assert.equal(fake.report(run.id, "summary.html").content_type, "text/html; charset=utf-8");
    const report = fake.report(run.id, "basic-test-page.walker.md");
    assert.equal(report.content_type, "text/markdown; charset=utf-8");
    assert.match(report.body, /\| Tab \| Save, button \|/);
    assert.equal(JSON.parse(fake.report(run.id, "basic-test-page.walker.json").body).status, "pass");
    assert.ok(fake.calls.filter((c) => c.op === "rpc").every((c) => c.args.p_token === WORKER_TOKEN), "every call carries the worker token");
    assert.ok(!fake.calls.some((c) => c.op !== "rpc"), "the worker reaches the database only through the worker_* functions");

    assert.deepEqual(
      { ...saved.summary, files: saved.summary.files.length },
      { results: 1, passed: 1, failed: 0, errored: 0, errors: result.errors, warnings: result.warnings, files: 5, blocked_requests: [], timed_out: false }
    );
    assert.equal(await worker.tick(), false, "the queue is now empty");
  });

  it("keeps a tested page away from addresses that are not listed exactly", async () => {
    const hits = [];
    const internal = createServer((req, res) => {
      hits.push(`internal ${req.url}`);
      res.end("secret");
    });
    await new Promise((done) => internal.listen(0, "127.0.0.1", done));
    const internalOrigin = `http://127.0.0.1:${internal.address().port}`;
    const stun = dgram.createSocket("udp4");
    let stunPackets = 0;
    stun.on("message", () => stunPackets++);
    await new Promise((done) => stun.bind(0, "127.0.0.1", done));
    const page = readFileSync(join(fixtures, "egress.html"), "utf8")
      .replaceAll("INTERNAL_ORIGIN", internalOrigin)
      .replaceAll("STUN_PORT", String(stun.address().port));
    const target = createServer((req, res) => {
      hits.push(`site ${req.url}`);
      if (req.url === "/egress.html") res.writeHead(200, { "Content-Type": "text/html" }).end(page);
      else res.writeHead(404).end();
    });
    await new Promise((done) => target.listen(0, "127.0.0.1", done));
    const host = `127.0.0.1:${target.address().port}`;
    try {
      const run = queued({ base_url: `http://${host}/`, journeys: [EGRESS] });
      const fake = fakeSupabase({ runs: [run] });
      await createWorker({ db: dbOf(fake), catalog, config: configFor(host), log: quiet }).tick();
      const saved = fake.run(run.id);
      assert.equal(saved.status, "done", saved.error);
      assert.equal(fake.tables.run_results[0].status, "pass", "the journey itself ran");
      assert.deepEqual(hits.filter((h) => h.includes("secret")), [], "no request reached the internal service or localhost");
      assert.ok(hits.includes("site /egress.html"));
      const blocked = saved.summary.blocked_requests.join("\n");
      assert.match(blocked, new RegExp(`127\\.0\\.0\\.1:${internal.address().port} `));
      assert.match(blocked, new RegExp(`localhost:${target.address().port} `));
      assert.match(blocked, /169\.254\.169\.254:80 /);
      assert.equal(stunPackets, 0, "WebRTC sent UDP straight to an internal address");
    } finally {
      internal.close();
      target.close();
      stun.close();
    }
  });

  it("stops a run at its timeout, browser included, and keeps what finished", async () => {
    const dir = await mkdtemp(join(tmpdir(), "srj-hang-"));
    const pidFile = join(dir, "pids.json");
    process.env.SRJ_TEST_PID_FILE = pidFile;
    try {
      const run = queued({ base_url: `${site.url}/`, journeys: [BASIC, HANG] });
      const fake = fakeSupabase({ runs: [run] });
      const started = Date.now();
      await createWorker({ db: dbOf(fake), catalog, config: configFor(new URL(site.url).host, { runTimeoutMs: 8000 }), log: quiet }).tick();
      assert.ok(Date.now() - started < 30000);
      const saved = fake.run(run.id);
      assert.equal(saved.status, "failed");
      assert.match(saved.error, /Timed out after 8 seconds; 1 of 2 journey runs finished/);
      assert.equal(saved.summary.timed_out, true);
      assert.deepEqual(fake.tables.run_results.map((r) => r.journey), [BASIC], "the journey that finished is kept");
      assert.ok(fake.report(run.id, "basic-test-page.walker.md"));

      const pids = JSON.parse(readFileSync(pidFile, "utf8"));
      assert.ok(pids.browsers.length > 0, "the hanging journey saw its browser");
      const alive = (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 50 && [pids.run, ...pids.browsers].some(alive); i++) await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual([pids.run, ...pids.browsers].filter(alive), [], "the run process and its browser are gone");
    } finally {
      delete process.env.SRJ_TEST_PID_FILE;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("worker, with a fake run process", () => {
  const HOST = "good.vercel.app";
  // A wildcard needs Chromium's sandbox (R8.3); these runs use a fake run process.
  const config = configFor("*.vercel.app", { chromiumSandbox: true });
  const lookup = async () => ["76.76.21.21"];
  const executeNothing = () => {
    throw new Error("should not run");
  };
  const summary = (journey, mode, status = "pass") => ({ journey, name: journey, mode, status, error: null, checks_total: 1, checks_passed: status === "pass" ? 1 : 0, errors: 0, warnings: 0, report_base: `x.${mode}` });

  for (const [what, fields, message] of [
    ["a host that is not allowed", { base_url: "https://evil.example/", journeys: [BASIC] }, /Refused: evil\.example is not one of the sites/],
    ["an internal address", { base_url: "http://127.0.0.1:8080/", journeys: [BASIC] }, /Refused: 127\.0\.0\.1:8080 is not one of the sites/],
    ["a journey that is not in the catalog", { base_url: `https://${HOST}/`, journeys: ["targets/../../evil.journey.js"] }, /Refused: .* not one of this server's journeys/],
    ["a mode the server does not run", { base_url: `https://${HOST}/`, journeys: [BASIC], modes: ["voiceover"] }, /Refused: .*needs a Mac/],
  ]) {
    it(`refuses ${what} even when inserted straight into the table`, async () => {
      const run = queued(fields);
      const fake = fakeSupabase({ runs: [run] });
      await createWorker({ db: dbOf(fake), catalog, config, execute: executeNothing, lookup, log: quiet }).tick();
      assert.equal(fake.run(run.id).status, "failed");
      assert.match(fake.run(run.id).error, message);
      assert.equal(fake.tables.run_reports.length, 0);
    });
  }

  it("refuses an allowed host that resolves to a private address", async () => {
    const run = queued({ base_url: "https://evil.vercel.app/", journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    await createWorker({ db: dbOf(fake), catalog, config, execute: executeNothing, lookup: async () => ["10.0.0.5"], log: quiet }).tick();
    assert.match(fake.run(run.id).error, /Refused: evil\.vercel\.app resolves to 10\.0\.0\.5/);
  });

  describe('with ALLOWED_TARGET_HOSTS="*", a run inserted straight into the table is checked again', () => {
    const anyConfig = configFor("*", { chromiumSandbox: true });

    it("refuses any run without Chromium's sandbox, however the worker was started (R8.2)", async () => {
      for (const hosts of ["*", "*.vercel.app"]) {
        const run = queued({ base_url: "https://example.vercel.app/", journeys: [BASIC] });
        const fake = fakeSupabase({ runs: [run] });
        let ran = false;
        await createWorker({ db: dbOf(fake), catalog, config: configFor(hosts), execute: async () => ((ran = true), executeNothing()), lookup, log: quiet }).tick();
        assert.equal(fake.run(run.id).status, "failed", hosts);
        assert.match(fake.run(run.id).error, /Refused: ALLOWED_TARGET_HOSTS with "\*" or a wildcard rule needs Chromium's sandbox/);
        assert.equal(ran, false);
      }
    });
    for (const [what, base, message] of [
      ["a private address", "http://10.0.0.1/", /Refused: 10\.0\.0\.1 is a private or reserved address/],
      ["the metadata address", "http://169.254.169.254/latest/", /Refused: 169\.254\.169\.254 is a private or reserved address/],
      ["an IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/", /Refused: .* is a private or reserved address/],
      ["another port", "https://example.org:8443/", /Refused: Port 8443 is not allowed/],
      ["a single-label host", "https://intranet/", /Refused: intranet is not a full host name/],
    ]) {
      it(`refuses ${what}`, async () => {
        const run = queued({ base_url: base, journeys: [BASIC] });
        const fake = fakeSupabase({ runs: [run] });
        let ran = false;
        await createWorker({ db: dbOf(fake), catalog, config: anyConfig, execute: async () => ((ran = true), executeNothing()), lookup, log: quiet }).tick();
        assert.equal(fake.run(run.id).status, "failed");
        assert.match(fake.run(run.id).error, message);
        assert.equal(ran, false, "no run process was started");
      });
    }

    it("refuses a public-looking host that resolves to a private address, before starting", async () => {
      const run = queued({ base_url: "https://looks-public.example.org/", journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      let ran = false;
      await createWorker({ db: dbOf(fake), catalog, config: anyConfig, execute: async () => ((ran = true), executeNothing()), lookup: async () => ["93.184.216.34", "192.168.1.20"], log: quiet }).tick();
      assert.match(fake.run(run.id).error, /Refused: looks-public\.example\.org resolves to 192\.168\.1\.20/);
      assert.equal(ran, false);
    });

    it("runs a public site, handing the run process the rule so every connection is checked", async () => {
      const run = queued({ base_url: "https://example.org/", journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      let job;
      await createWorker({ db: dbOf(fake), catalog, config: anyConfig, execute: async (j) => ((job = j), executeNothing()), lookup, log: quiet }).tick();
      assert.equal(job.baseUrl, "https://example.org/");
      assert.equal(job.allowedTargetHosts, "*");
      assert.equal(job.chromiumSandbox, true, "the run itself is launched sandboxed (R8.2)");
    });
  });

  it("cuts a run's error by code point, so half an emoji never reaches the database (R6.1, R6.2)", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    // A NUL and a lone surrogate first, then an emoji across the cut by code unit (units 498-499).
    const execute = async () => ({ outcome: "error", error: `\u0000\ud800${"x".repeat(496)}\u{1F600}${"y".repeat(50)}`, results: [], blocked: [] });
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
    const { error } = fake.run(run.id);
    assert.ok(error.isWellFormed(), "no lone surrogate");
    assert.ok(!error.includes("\u0000"), "no NUL");
    assert.ok(error.includes("\u{1F600}"), "the emoji is kept whole");
    assert.ok(Array.from(error).length <= 500);
  });

  it("looks at a bounded slice of a huge text only, when it cuts it (R7.5)", async () => {
    // Every cut cleans its text with toWellFormed; record how long the strings it sees are.
    const seen = [];
    const real = String.prototype.toWellFormed;
    String.prototype.toWellFormed = function () {
      seen.push(this.length);
      return real.call(this);
    };
    try {
      const huge = "h".repeat(1_000_000);
      summarizeRun({ results: [], blocked: [huge], outcome: "done" }, [], [huge]);
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      await createWorker({ db: dbOf(fake), catalog, config, execute: async () => ({ outcome: "error", error: huge, results: [], blocked: [] }), lookup, log: quiet }).tick();
      assert.equal(fake.run(run.id).status, "failed");
    } finally {
      String.prototype.toWellFormed = real;
    }
    assert.ok(seen.length > 0);
    assert.ok(Math.max(...seen) <= 2 * 500 + 2, `longest text cleaned: ${Math.max(...seen)}`);
  });

  it("quotes a run's base URL in the log, and cuts a refusal's reason to its first line (R7.5)", async () => {
    const run = queued({ base_url: "https://x.example/\nrun 1: done", journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const lines = [];
    await createWorker({ db: dbOf(fake), catalog, config, execute: executeNothing, lookup, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } }).tick();
    // Quoted, and only its first line: the forged part never reaches the log.
    assert.ok(lines.some((m) => m.endsWith('started ("https://x.example/")')), lines.join(" | "));

    const second = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake2 = fakeSupabase({ runs: [second] });
    fake2.failures.push({ op: "rpc", name: "worker_save_report", error: { code: "23514", message: "first line\nrun 9: forged" } });
    const execute = async (job) => {
      await writeFile(join(job.outDir, "a.md"), "x");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    const lines2 = [];
    await createWorker({ db: dbOf(fake2), catalog, config, execute, lookup, log: { log: (m) => lines2.push(m), error: (m) => lines2.push(m) } }).tick();
    assert.ok(lines2.some((m) => /left out "a\.md" \(worker_save_report: first line\)$/.test(m)), lines2.join(" | "));
    assert.ok([...lines, ...lines2].every((m) => !m.includes("\n")), "no line holds a newline");
  });

  it("quotes a file's name in the log, so a newline in it cannot forge a line (R6.2)", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const execute = async (job) => {
      await writeFile(join(job.outDir, "x\nrun 1: done.bin"), "x");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    const lines = [];
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } }).tick();
    assert.ok(lines.some((m) => m.includes('left out "x\\nrun 1: done.bin"')), lines.join("\n"));
    assert.ok(lines.every((m) => !m.includes("\n")), "no line holds a newline");
  });

  it("logs one line when the network guard's byte limit closed a run's connections (R8.1)", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const lines = [];
    const execute = async () => ({ outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: ["all connections (byte limit: the run moved its 100 MB through the network guard)"] });
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } }).tick();
    assert.equal(lines.filter((m) => m.endsWith(": the network guard's byte limit closed its connections")).length, 1);
    assert.match(fake.run(run.id).summary.blocked_requests[0], /byte limit/);
  });

  it("hands the run process only the checked job", async () => {
    const run = queued({ base_url: `https://${HOST}/x`, journeys: [BASIC, BASIC], modes: ["walker", "virtual"] });
    const fake = fakeSupabase({ runs: [run] });
    let job;
    const execute = async (j, { timeoutMs, signal }) => {
      job = j;
      assert.equal(timeoutMs, config.runTimeoutMs);
      assert.ok(signal instanceof AbortSignal);
      return { outcome: "done", error: null, results: [summary(BASIC, "walker"), summary(BASIC, "virtual", "fail")], blocked: ["a:1 (x)", "a:1 (x)"] };
    };
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
    assert.equal(job.baseUrl, `https://${HOST}/x`);
    assert.deepEqual(job.journeys, [{ path: BASIC, file: join(REPO_ROOT, BASIC) }]);
    assert.deepEqual(job.modes, ["walker", "virtual"]);
    assert.equal(job.allowedTargetHosts, "*.vercel.app");
    const saved = fake.run(run.id);
    assert.equal(saved.status, "done");
    assert.deepEqual([saved.summary.passed, saved.summary.failed, saved.summary.blocked_requests], [1, 1, ["a:1 (x)"]]);
    assert.deepEqual(fake.tables.run_results.map((r) => [r.mode, r.status, r.report_path]), [["walker", "pass", null], ["virtual", "fail", null]]);
  });

  it("marks a run failed when the run process fails", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const execute = async () => ({ outcome: "error", error: "browserType.launch: Executable doesn't exist", results: [], blocked: [] });
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
    assert.equal(fake.run(run.id).status, "failed");
    assert.match(fake.run(run.id).error, /Executable doesn't exist/);
  });

  it("marks a run failed when saving its results fails, rather than leaving it running", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    fake.failures.push({ op: "rpc", name: "worker_add_results", error: { message: "connection reset" } });
    const execute = async () => ({ outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] });
    const logged = [];
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: { log() {}, error: (line) => logged.push(line) } }).tick();
    assert.equal(fake.run(run.id).status, "failed");
    // The user sees a plain sentence; the database's message goes to the log only.
    assert.match(fake.run(run.id).error, /^The server could not finish this run\./);
    assert.doesNotMatch(fake.run(run.id).error, /connection reset/);
    assert.ok(logged.some((line) => /worker_add_results: connection reset/.test(line)), logged.join("\n"));
  });

  it("puts a run back in the queue when the server shuts down during it", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    let started;
    const running = new Promise((resolve) => (started = resolve));
    const execute = (job, { signal }) =>
      new Promise((resolve) => {
        started();
        signal.addEventListener("abort", () => resolve({ outcome: "aborted", error: null, results: [], blocked: [] }));
      });
    const worker = createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet, probeSandbox: async () => null, exit: () => {} });
    worker.start();
    await running;
    assert.equal(worker.busy, true);
    await worker.stop();
    assert.equal(fake.run(run.id).status, "queued");
    assert.equal(fake.run(run.id).started_at, null);
  });

  it("does nothing with a wrong worker token, and says so in the log", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const errors = [];
    const worker = createWorker({ db: dbOf(fake, "not-the-worker-token-0123456789abcdef"), catalog, config, execute: executeNothing, lookup, log: { log() {}, error: (m) => errors.push(m) } });
    await assert.rejects(worker.tick(), /worker_fail_stale_runs: Bad worker token/);
    assert.equal(fake.run(run.id).status, "queued");
  });

  it("leaves out report files that are too large or not a report type", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const execute = async (job) => {
      await writeFile(join(job.outDir, "summary.md"), "# Summary");
      await writeFile(join(job.outDir, "huge.json"), "x".repeat(MAX_REPORT_BYTES + 1));
      await writeFile(join(job.outDir, "core.bin"), "x");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
    const saved = fake.run(run.id);
    assert.equal(saved.status, "done");
    assert.deepEqual(fake.tables.run_reports.map((r) => r.path), ["summary.md"]);
    assert.deepEqual(saved.summary.files, ["summary.md"]);
    assert.deepEqual(saved.summary.skipped_files, ["core.bin", "huge.json"]);
    assert.ok(!fake.calls.some((c) => c.name === "worker_save_report" && c.args.p_path === "huge.json"), "the large file is never sent");
  });

  it("keeps a report whose text has NUL characters, with U+FFFD in their place", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const execute = async (job) => {
      await writeFile(join(job.outDir, "summary.md"), "| Tab | a\u0000b, button |");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
    assert.equal(fake.run(run.id).status, "done");
    assert.equal(fake.report(run.id, "summary.md").body, "| Tab | a\uFFFDb, button |");
  });

  it("leaves out a file the database refuses or could not name, and still finishes the run", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    fake.failures.push({ op: "rpc", name: "worker_save_report", error: { code: "54000", message: "A run keeps at most 20 MiB of reports." } });
    const execute = async (job) => {
      await writeFile(join(job.outDir, "a.md"), "first, refused");
      await writeFile(join(job.outDir, "b.md"), "second, kept");
      await writeFile(join(job.outDir, ".hidden.md"), "not a name the table takes");
      await writeFile(join(job.outDir, `${"x".repeat(198)}.md`), "too long a name");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    const logged = [];
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: { log: (line) => logged.push(line), error() {} } }).tick();
    const saved = fake.run(run.id);
    assert.equal(saved.status, "done");
    assert.deepEqual(saved.summary.files, ["b.md"]);
    const [hidden, refused, long] = saved.summary.skipped_files.sort();
    assert.deepEqual([hidden, refused], [".hidden.md", "a.md"]);
    // The too-long name is named, cut in the middle to 200 characters, so its extension shows.
    assert.equal(long.length, 200);
    assert.match(long, /^x+…x+\.md$/);
    assert.ok(logged.some((line) => /left out "a\.md" \(worker_save_report: A run keeps at most 20 MiB/.test(line)), logged.join("\n"));
    assert.equal(fake.tables.run_results.length, 1, "the results are kept");
  });

  it("never follows a link the run left in its reports, to a file or to a folder (R2.1)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "srj-outside-"));
    const MARKER = "MARKER-read-only-by-the-server";
    await writeFile(join(outside, "secret.txt"), MARKER);
    await writeFile(join(outside, "inside.md"), MARKER);
    try {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const execute = async (job) => {
        await writeFile(join(job.outDir, "summary.md"), "# Summary");
        await symlink(join(outside, "secret.txt"), join(job.outDir, "leak.txt"));
        await symlink("/proc/self/environ", join(job.outDir, "environ.txt"));
        await symlink(outside, join(job.outDir, "folder"));
        return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
      };
      await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
      const saved = fake.run(run.id);
      assert.equal(saved.status, "done");
      assert.deepEqual(fake.tables.run_reports.map((r) => r.path), ["summary.md"]);
      assert.deepEqual(saved.summary.skipped_files, ["environ.txt", "folder", "leak.txt"]);
      assert.ok(!fake.tables.run_reports.some((r) => r.body.includes(MARKER)), "the marker was read");
      assert.ok(!fake.calls.some((c) => JSON.stringify(c.args ?? {}).includes(MARKER)), "the marker was sent");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reads nothing when the run has replaced its reports folder with a link (R2.2-1)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "srj-outside-"));
    const MARKER = "MARKER-in-a-folder-the-run-pointed-at";
    await writeFile(join(outside, "credentials.json"), JSON.stringify({ secret: MARKER }));
    try {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const execute = async (job) => {
        await writeFile(join(job.outDir, "summary.md"), "# Summary");
        await rename(job.outDir, `${job.outDir}.old`);
        await symlink(outside, job.outDir);
        return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
      };
      await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
      assert.equal(fake.run(run.id).status, "failed");
      assert.equal(fake.tables.run_reports.length, 0);
      assert.ok(!fake.calls.some((c) => JSON.stringify(c.args ?? {}).includes(MARKER)), "the marker was sent");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("leaves out a hard link to a file outside the run (R2.2-3)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "srj-outside-"));
    const MARKER = "MARKER-behind-a-hard-link";
    await writeFile(join(outside, "secret.txt"), MARKER);
    try {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const execute = async (job) => {
        await writeFile(join(job.outDir, "summary.md"), "# Summary");
        await link(join(outside, "secret.txt"), join(job.outDir, "hard.txt"));
        return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
      };
      await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
      assert.equal(fake.run(run.id).status, "done");
      assert.deepEqual(fake.tables.run_reports.map((r) => r.path), ["summary.md"]);
      assert.deepEqual(fake.run(run.id).summary.skipped_files, ["hard.txt"]);
      assert.ok(!fake.calls.some((c) => JSON.stringify(c.args ?? {}).includes(MARKER)), "the marker was sent");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("with RUN_AS_UID, stops that user's processes before the run, before reading its reports, and at the end", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const events = [];
    let workDir;
    const execute = async (job) => {
      events.push("execute");
      workDir = join(job.outDir, "..");
      await writeFile(join(job.outDir, "summary.md"), "# Summary");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    const stopProcesses = async (runAs) => events.push(`stop ${runAs.uid}:${runAs.gid}`);
    // runAs needs root for chown; a uid of our own keeps it working without root.
    const uid = process.getuid();
    const gid = process.getgid();
    const own = { ...config, runAs: { uid, gid } };
    const exits = [];
    await createWorker({ db: dbOf(fake), catalog, config: own, execute, lookup, log: quiet, stopProcesses, exit: (code) => exits.push(code) }).tick();
    assert.deepEqual(events, [`stop ${uid}:${gid}`, "execute", `stop ${uid}:${gid}`, `stop ${uid}:${gid}`]);
    assert.equal(fake.run(run.id).status, "done");
    // Read through the run user's child, then emptied by it and removed folder by folder.
    assert.equal(fake.report(run.id, "summary.md").body, "# Summary");
    assert.ok(!existsSync(workDir), "the work folder is gone");
    assert.deepEqual(exits, []);
  });

  describe("with RUN_AS_UID, the run's files go through the run user's child only (R2.G-4)", () => {
    const own = () => ({ ...config, runAs: { uid: process.getuid(), gid: process.getgid() } });
    /**
     * A stand-in for startReportChild: answers like the real child (report-child.js handle), or
     * as `answer` says, and records each request. close() fails what is still waiting, and, as
     * with the real child, every call after it.
     */
    const fakeChild = (requests, answer = handle) => () => {
      const pending = new Set();
      let closed = false;
      return {
        call(request) {
          requests.push(request);
          if (closed) return Promise.reject(new Error("report child: the channel is closed"));
          return new Promise((resolve, reject) => {
            const entry = { reject };
            pending.add(entry);
            Promise.resolve(answer(request)).then(
              (value) => (pending.delete(entry), resolve(value)),
              (error) => (pending.delete(entry), reject(error))
            );
          });
        },
        close() {
          closed = true;
          for (const { reject } of pending) reject(new Error("report child ended"));
          pending.clear();
        },
      };
    };
    const withFolder = (write) => {
      let workDir;
      const execute = async (job) => {
        workDir = join(job.outDir, "..");
        await write?.(job.outDir);
        return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
      };
      return { execute, workDir: () => workDir };
    };

    it("reads the reports from the child's answers, not from the folder", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const requests = [];
      const answer = (request) => {
        if (request.op === "list") return { files: ["from-child.md"], others: [] };
        if (request.op === "read") return { text: "via the child" };
        return clearFolders(request.dirs);
      };
      const { execute, workDir } = withFolder((outDir) => writeFile(join(outDir, "summary.md"), "in the folder"));
      const exits = [];
      await createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild(requests, answer), exit: (c) => exits.push(c) }).tick();
      assert.deepEqual(fake.tables.run_reports.map((r) => [r.path, r.body]), [["from-child.md", "via the child"]], "root read nothing itself");
      assert.deepEqual(requests.map((r) => r.op), ["list", "read", "clear"]);
      assert.ok(!existsSync(workDir()), "emptied by the child, then removed folder by folder");
      assert.deepEqual(exits, []);
    });

    it("never deletes the run's files as root: what the child leaves stays, and the server ends (R2.G-2)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const requests = [];
      const answer = (request) => (request.op === "clear" ? { left: [join(request.dirs[0], "summary.md")] } : handle(request));
      const { execute, workDir } = withFolder((outDir) => writeFile(join(outDir, "summary.md"), "# Summary"));
      const exits = [];
      try {
        await createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild(requests, answer), exit: (c) => exits.push([c, fake.run(run.id).status]) }).tick();
        assert.equal(fake.run(run.id).status, "done");
        assert.ok(existsSync(join(workDir(), "reports", "summary.md")), "root did not remove it");
        const { statSync } = await import("node:fs");
        for (const dir of ["reports", "home"]) {
          const info = statSync(join(workDir(), dir));
          assert.equal(info.mode & 0o777, 0o700, `${dir} is closed to everyone else`);
          assert.equal(info.uid, process.getuid(), `${dir} is the server's now`);
        }
        assert.deepEqual(exits, [[1, "done"]]);
      } finally {
        if (workDir()) await rm(workDir(), { recursive: true, force: true });
      }
    });

    it("fails the run on a malformed answer from the child (R2.G-5)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const answer = (request) => (request.op === "list" ? { files: ["../../etc/passwd.md"], others: [] } : handle(request));
      const { execute } = withFolder();
      await createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild([], answer), exit: () => {} }).tick();
      assert.equal(fake.run(run.id).status, "failed");
      assert.equal(fake.tables.run_reports.length, 0);
    });

    it("rejects a clear answer that names a path outside the folders asked for (R2.H-3)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const answer = (request) => (request.op === "clear" ? { left: ["/etc/passwd"] } : handle(request));
      const { execute, workDir } = withFolder();
      const errors = [];
      const exits = [];
      try {
        await createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: { log() {}, error: (m) => errors.push(m) }, stopProcesses: async () => {}, startChild: fakeChild([], answer), exit: (c) => exits.push(c) }).tick();
        assert.ok(errors.some((m) => m.includes("a malformed answer to clear")), errors.join("\n"));
        assert.deepEqual(exits, [1]);
      } finally {
        if (workDir()) await rm(workDir(), { recursive: true, force: true });
      }
    });

    it("locks the folders away and ends the server when rmdir fails after an empty clear (R2.H-1)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      // The child says it removed everything, but summary.md is still there, so rmdir fails.
      const answer = (request) => (request.op === "clear" ? { left: [] } : handle(request));
      const { execute, workDir } = withFolder((outDir) => writeFile(join(outDir, "summary.md"), "# Summary"));
      const exits = [];
      try {
        await createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild([], answer), exit: (c) => exits.push(c) }).tick();
        const { statSync } = await import("node:fs");
        const info = statSync(join(workDir(), "reports"));
        assert.equal(info.mode & 0o777, 0o700);
        assert.equal(info.uid, process.getuid());
        assert.deepEqual(exits, [1]);
      } finally {
        if (workDir()) await rm(workDir(), { recursive: true, force: true });
      }
    });

    // The limits below are measured on an injected clock (`now`), which the fakes move: no test
    // waits on real time.
    const files = (...names) => async (outDir) => {
      for (const name of names) await writeFile(join(outDir, name), `# ${name}`);
    };

    it("counts only the child's answers against the read limit, not the database's writes (R2.H-3)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const clock = { t: 0 };
      const db = dbOf(fake);
      const slowDb = { ...db, saveReport: async (...args) => ((clock.t += 150), db.saveReport(...args)) };
      const { execute } = withFolder(files("summary.md", "second.md"));
      await createWorker({ db: slowDb, catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild([]), readLimitMs: 100, now: () => clock.t, exit: () => {} }).tick();
      assert.equal(fake.run(run.id).status, "done");
      assert.deepEqual(fake.tables.run_reports.map((r) => r.path).sort(), ["second.md", "summary.md"]);
    });

    it("adds up the child's answers against the read limit (R2.H-3)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const clock = { t: 0 };
      // Each read takes 60 of the 100 allowed: the second ends over the limit, so a third may not start.
      const answer = async (request) => {
        if (request.op === "read") clock.t += 60;
        return handle(request);
      };
      const requests = [];
      const { execute } = withFolder(files("a.md", "b.md", "c.md"));
      await createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild(requests, answer), readLimitMs: 100, now: () => clock.t, exit: () => {} }).tick();
      assert.equal(fake.run(run.id).status, "failed");
      assert.equal(requests.filter((r) => r.op === "read").length, 2, "the third read was never sent");
    });

    it("bounds the whole save in time, database writes included, and leaves out what is still waiting (R4.1)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const clock = { t: 0 };
      const db = dbOf(fake);
      let calls = 0;
      const slowDb = { ...db, saveReport: async (...args) => ((calls += 1), (clock.t += 2000), db.saveReport(...args)) };
      const lines = [];
      const { execute } = withFolder(files("a.md", "b.md", "c.md", "d.md"));
      await createWorker({ db: slowDb, catalog, config: own(), execute, lookup, log: { log: (m) => lines.push(m), error() {} }, stopProcesses: async () => {}, startChild: fakeChild([]), saveLimitMs: 3000, now: () => clock.t, exit: () => {} }).tick();
      assert.equal(fake.run(run.id).status, "done");
      assert.equal(calls, 2, "no write once the limit had passed");
      assert.deepEqual(fake.run(run.id).summary.skipped_files, ["c.md", "d.md"]);
      assert.equal(lines.filter((m) => m.includes("left out")).length, 1, "logged once, not file by file");
      assert.ok(lines.some((m) => m.includes("left out 2 more files (saving the reports took longer than 3 s)")), lines.join("\n"));
    });

    it(`stops asking the database once ${MAX_REPORT_FILES} files are kept (R4.1)`, async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const db = dbOf(fake);
      let calls = 0;
      const countingDb = { ...db, saveReport: async (...args) => ((calls += 1), db.saveReport(...args)) };
      const names = Array.from({ length: MAX_REPORT_FILES + 30 }, (_, i) => `r${String(i).padStart(3, "0")}.md`);
      const requests = [];
      // zz.bin is left out on its own (not a report type), and named before the files left out
      // in bulk, though it sorts after them (R5.1).
      const { execute } = withFolder(files(...names, "zz.bin"));
      await createWorker({ db: countingDb, catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild(requests), exit: () => {} }).tick();
      assert.equal(fake.run(run.id).status, "done");
      assert.equal(calls, MAX_REPORT_FILES);
      assert.equal(requests.filter((r) => r.op === "read").length, MAX_REPORT_FILES, "nor the child");
      const { summary } = fake.run(run.id);
      assert.equal(summary.skipped_count, 31);
      assert.equal(summary.skipped_files.length, 20, "named up to 20, counted in full");
      assert.equal(summary.skipped_files[0], "zz.bin");
    });

    it("logs each file left out one by one only up to a limit, then counts them (R5.1)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const lines = [];
      const { execute } = withFolder(files(...Array.from({ length: 50 }, (_, i) => `x${i}.bin`)));
      await createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: { log: (m) => lines.push(m), error() {} }, stopProcesses: async () => {}, startChild: fakeChild([]), exit: () => {} }).tick();
      assert.equal(fake.run(run.id).status, "done");
      const leftOut = lines.filter((m) => m.includes("left out"));
      assert.equal(leftOut.length, 31, leftOut.slice(-3).join("\n"));
      assert.match(leftOut.at(-1), /left out 20 more files/);
      assert.equal(fake.run(run.id).summary.skipped_count, 50);
    });

    it("stops asking the database once it refuses a file for the cap on files (R4.1)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const db = dbOf(fake);
      let calls = 0;
      const cappedDb = {
        ...db,
        saveReport: async (...args) => {
          calls += 1;
          if (calls === 2) throw Object.assign(new Error("worker_save_report: A run keeps at most 200 report files."), { code: "54000" });
          return db.saveReport(...args);
        },
      };
      const { execute } = withFolder(files("a.md", "b.md", "c.md", "d.md"));
      await createWorker({ db: cappedDb, catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild([]), exit: () => {} }).tick();
      assert.equal(fake.run(run.id).status, "done");
      assert.equal(calls, 2);
      assert.deepEqual(fake.run(run.id).summary.skipped_files, ["b.md", "c.md", "d.md"]);
    });

    it("does not start on a host where the run's user could trace the stop helper (R2.H-2)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const exits = [];
      const errors = [];
      const execute = async () => ({ outcome: "done", error: null, results: [], blocked: [] });
      const worker = createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: { log() {}, error: (m) => errors.push(m) }, stopProcesses: async () => {}, readSuidDumpable: () => "1\n", exit: (c) => exits.push(c) });
      try {
        await Promise.race([worker.start(), new Promise((r) => setTimeout(r, 500))]);
        assert.deepEqual(exits, [1]);
        assert.ok(errors.some((m) => m.includes("suid_dumpable")), errors.join("\n"));
        assert.equal(fake.run(run.id).status, "queued", "no run was claimed");
      } finally {
        await worker.stop();
      }
    });

    describe('with ALLOWED_TARGET_HOSTS="*", the worker starts only with a working sandbox (R7.1)', () => {
      const start = async ({ sandbox, probe, stop = async () => {}, hosts = "*" }) => {
        const run = queued({ base_url: "https://example.org/", journeys: [BASIC] });
        const fake = fakeSupabase({ runs: [run] });
        const exits = [];
        const errors = [];
        const probed = [];
        const stopped = [];
        const worker = createWorker({
          db: dbOf(fake),
          catalog,
          config: { ...own(), ...configFor(hosts, { runAs: own().runAs, chromiumSandbox: sandbox }) },
          execute: async () => ({ outcome: "done", error: null, results: [], blocked: [] }),
          lookup,
          log: { log() {}, error: (m) => errors.push(m) },
          stopProcesses: async (runAs) => (stopped.push(runAs), stop()),
          readSuidDumpable: () => "2",
          probeSandbox: async (runAs, options) => (probed.push(runAs), probe?.(options)),
          exit: (c) => exits.push(c),
        });
        const loop = worker.start();
        await Promise.race([loop, new Promise((r) => setTimeout(r, 300))]);
        await worker.stop();
        return { exits, errors, probed, stopped, status: fake.run(run.id).status };
      };

      it("refuses without CHROMIUM_SANDBOX=true, and does not probe", async () => {
        const { exits, errors, probed, status } = await start({ sandbox: false });
        assert.deepEqual(exits, [1]);
        assert.ok(errors.some((m) => /not starting the worker: ALLOWED_TARGET_HOSTS with "\*" or a wildcard rule needs Chromium's sandbox: set CHROMIUM_SANDBOX=true/.test(m)), errors.join("\n"));
        assert.deepEqual(probed, []);
        assert.equal(status, "queued", "no run was claimed");
      });

      it("refuses when a sandboxed Chromium does not start here, and stops what the probe left", async () => {
        const { exits, errors, probed, stopped, status } = await start({ sandbox: true, probe: () => "No usable sandbox!" });
        assert.deepEqual(exits, [1]);
        assert.ok(errors.some((m) => m.includes("which did not start here: No usable sandbox!")), errors.join("\n"));
        assert.equal(probed.length, 1);
        assert.equal(stopped.length, 1, "the probe's processes were stopped");
        assert.equal(status, "queued");
      });

      it("asks the same of a wildcard rule, which anyone may host a page under (R8.3)", async () => {
        const { exits, errors, probed } = await start({ sandbox: false, hosts: "*.vercel.app" });
        assert.deepEqual(exits, [1]);
        assert.ok(errors.some((m) => /a wildcard rule needs Chromium's sandbox/.test(m)), errors.join("\n"));
        assert.deepEqual(probed, []);
        const exact = await start({ sandbox: false, hosts: "example.org" });
        assert.deepEqual([exact.exits, exact.probed], [[], []], "exact hosts alone do not need it");
      });

      it("ends the probe when the worker stops, without exiting as a failure (R8.2)", { timeout: 10000 }, async () => {
        let ended = false;
        const probe = ({ signal }) => new Promise((resolve) => signal.addEventListener("abort", () => ((ended = true), resolve("the probe ended (SIGKILL)"))));
        const { exits, errors } = await start({ sandbox: true, probe });
        assert.equal(ended, true, "stop() ended the probe");
        assert.deepEqual(exits, [], errors.join("\n"));
      });

      it("refuses when what the probe left cannot be stopped", async () => {
        const { exits, errors } = await start({ sandbox: true, probe: () => null, stop: () => Promise.reject(new Error("still running: 42")) });
        assert.deepEqual(exits, [1]);
        assert.ok(errors.some((m) => m.includes("the sandbox probe's processes did not stop (still running: 42)")), errors.join("\n"));
      });

      it("starts, and takes runs, when the sandbox works", async () => {
        const { exits, probed, status } = await start({ sandbox: true, probe: () => null });
        assert.deepEqual(exits, []);
        assert.equal(probed.length, 1);
        assert.equal(status, "done", "the run was taken and finished");
      });
    });

    it("bounds the whole read, not only each request (R2.G-5)", async () => {
      const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      const answer = (request) => (request.op === "read" ? new Promise(() => {}) : handle(request));
      const { execute } = withFolder((outDir) => writeFile(join(outDir, "summary.md"), "# Summary"));
      await createWorker({ db: dbOf(fake), catalog, config: own(), execute, lookup, log: quiet, stopProcesses: async () => {}, startChild: fakeChild([], answer), readLimitMs: 100, exit: () => {} }).tick();
      assert.equal(fake.run(run.id).status, "failed");
    });
  });

  it("when only the stop before reading fails: reads and deletes nothing, and ends the server (R2.F-2)", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    let stops = 0;
    const stopProcesses = async () => {
      if (++stops === 2) throw new Error("processes of user 10001 are still running: 99");
    };
    let workDir;
    const execute = async (job) => {
      workDir = join(job.outDir, "..");
      await writeFile(join(job.outDir, "summary.md"), "# Summary");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    const exits = [];
    const own = { ...config, runAs: { uid: process.getuid(), gid: process.getgid() } };
    try {
      await createWorker({ db: dbOf(fake), catalog, config: own, execute, lookup, log: quiet, stopProcesses, exit: (code) => exits.push([code, fake.run(run.id).status]) }).tick();
      assert.equal(stops, 3, "the last stop succeeded");
      assert.equal(fake.tables.run_reports.length, 0);
      assert.deepEqual(exits, [[1, "failed"]]);
      assert.ok(existsSync(join(workDir, "reports", "summary.md")), "the run's folder is left alone");
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  });

  it("when the run's processes will not stop: fails the run, reads and deletes nothing, and ends the server (R2.3-2)", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    let stops = 0;
    const stopProcesses = async () => {
      if (++stops >= 2) throw new Error("processes of user 10001 are still running: 99");
    };
    let workDir;
    const execute = async (job) => {
      workDir = join(job.outDir, "..");
      await writeFile(join(job.outDir, "summary.md"), "# Summary");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    const exits = [];
    const exit = (code) => exits.push([code, fake.run(run.id).status]);
    const own = { ...config, runAs: { uid: process.getuid(), gid: process.getgid() } };
    try {
      await createWorker({ db: dbOf(fake), catalog, config: own, execute, lookup, log: quiet, stopProcesses, exit }).tick();
      assert.equal(fake.run(run.id).status, "failed");
      assert.equal(fake.tables.run_reports.length, 0);
      assert.deepEqual(exits, [[1, "failed"]], "the server ends once, after the run is marked failed");
      assert.ok(existsSync(join(workDir, "reports", "summary.md")), "the run's folder is left alone");
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  });

  it("also ends the server when only the last stop fails, on a run put back for a deploy", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    let stops = 0;
    const stopProcesses = async () => {
      if (++stops === 2) throw new Error("processes of user 10001 are still running: 99");
    };
    let workDir;
    const execute = async (job) => {
      workDir = join(job.outDir, "..");
      return { outcome: "aborted", error: null, results: [], blocked: [] };
    };
    const exits = [];
    const own = { ...config, runAs: { uid: process.getuid(), gid: process.getgid() } };
    try {
      await createWorker({ db: dbOf(fake), catalog, config: own, execute, lookup, log: quiet, stopProcesses, exit: (code) => exits.push(code) }).tick();
      assert.equal(fake.run(run.id).status, "queued", "requeued first");
      assert.deepEqual(exits, [1]);
      assert.ok(existsSync(workDir), "the run's folder is left alone");
    } finally {
      if (workDir) await rm(workDir, { recursive: true, force: true });
    }
  });

  it("fails the run when saving a report fails for a reason other than a refusal (R2.3)", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    fake.failures.push({ op: "rpc", name: "worker_save_report", error: { message: "fetch failed" } });
    const execute = async (job) => {
      await writeFile(join(job.outDir, "summary.md"), "# Summary");
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
    assert.equal(fake.run(run.id).status, "failed");
    assert.match(fake.run(run.id).error, /^The server could not finish this run\./);
  });

  it("still claims runs when pruning fails, and tries pruning again an hour later (R2.2)", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    fake.failures.push({ op: "rpc", name: "worker_prune_runs", error: { message: "Could not find the function worker_prune_runs" } });
    const execute = async () => ({ outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] });
    const errors = [];
    const worker = createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: { log() {}, error: (m) => errors.push(m) } });
    assert.equal(await worker.tick(), true);
    assert.equal(fake.run(run.id).status, "done");
    assert.match(errors.join("\n"), /pruning: worker_prune_runs: Could not find the function/);
    await worker.tick();
    assert.equal(fake.calls.filter((c) => c.name === "worker_prune_runs").length, 1, "not again at once");
  });

  it("deletes finished runs over 30 days old, about once an hour", async () => {
    const old = queued({ base_url: `https://${HOST}/`, journeys: [BASIC], status: "done", finished_at: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString() });
    const recent = queued({ base_url: `https://${HOST}/`, journeys: [BASIC], status: "done", finished_at: new Date().toISOString() });
    const fake = fakeSupabase({ runs: [old, recent] });
    const worker = createWorker({ db: dbOf(fake), catalog, config, execute: executeNothing, lookup, log: quiet });
    await worker.tick();
    await worker.tick();
    assert.deepEqual(fake.tables.runs.map((r) => r.id), [recent.id]);
    assert.equal(fake.calls.filter((c) => c.name === "worker_prune_runs").length, 1, "not on every tick");
  });

  it("stops saving reports when the run has been deleted", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const execute = async (job) => {
      await writeFile(join(job.outDir, "a.md"), "a");
      await writeFile(join(job.outDir, "b.md"), "b");
      fake.tables.runs.splice(0); // the owner deleted the run while it ran
      return { outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] };
    };
    await createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet }).tick();
    assert.equal(fake.tables.run_reports.length, 0);
    assert.equal(fake.calls.filter((c) => c.name === "worker_save_report").length, 1, "one try, then it stops");
  });

  it("fails runs left running by a server that stopped", async () => {
    const old = queued({ base_url: `https://${HOST}/`, journeys: [BASIC], status: "running", started_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const recent = queued({ base_url: `https://${HOST}/`, journeys: [BASIC], status: "running", started_at: new Date().toISOString() });
    const fake = fakeSupabase({ runs: [old, recent] });
    assert.equal(await createWorker({ db: dbOf(fake), catalog, config, execute: executeNothing, lookup, log: quiet }).tick(), false);
    assert.equal(fake.run(old.id).status, "failed");
    assert.match(fake.run(old.id).error, /server stopped/);
    assert.equal(fake.run(recent.id).status, "running");
  });

  it("keeps polling after Supabase errors", async () => {
    const fake = fakeSupabase();
    let claims = 0;
    fake.rpc = async () => {
      claims += 1;
      return { data: null, error: { message: "upstream unavailable" } };
    };
    const errors = [];
    const worker = createWorker({ db: dbOf(fake), catalog, config, execute: executeNothing, lookup, log: { log() {}, error: (m) => errors.push(m) }, probeSandbox: async () => null, exit: () => {} });
    worker.start();
    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();
    assert.ok(claims >= 2, `polled ${claims} times`);
    assert.match(errors[0], /worker_fail_stale_runs: upstream unavailable/);
  });
});

describe("a run's summary fits the database's 64 KiB check (R5.1)", () => {
  const outcome = (blocked = []) => ({ results: [], blocked, outcome: "done" });
  const bytes = (summary) => Buffer.byteLength(JSON.stringify(summary));
  // jsonb's text adds a space after each comma and colon; the summary leaves room for that.
  const asJsonb = (summary) => bytes(summary) + (JSON.stringify(summary).match(/[,:]/g) ?? []).length;

  it("cuts long names, and names 20 of them, counting all", () => {
    const skipped = Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(4096, "a"));
    const summary = summarizeRun(outcome(), [], skipped);
    assert.equal(summary.skipped_count, 25);
    assert.equal(summary.skipped_files.length, 20);
    assert.ok(summary.skipped_files.every((name) => name.length <= 200));
    assert.ok(asJsonb(summary) <= 65536);
  });

  it("keeps the byte limit's entry first, past the cap of 50 and the size guard (R8.1)", () => {
    const refusals = Array.from({ length: 60 }, (_, i) => `10.0.${i}.1:443 (private) ${"p".repeat(250)}`);
    const limit = "all connections (byte limit: the run moved its 100 MB through the network guard)";
    const files = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(200, "f"));
    const summary = summarizeRun(outcome([...refusals, limit]), files, []);
    assert.equal(summary.blocked_requests[0], limit);
  });

  it("cuts by code point, so no half of an emoji is left for jsonb to refuse", () => {
    const skipped = Array.from({ length: 3 }, (_, i) => `${i}${"\u{1F600}".repeat(2000)}`);
    const blocked = [`${"\u{1F600}".repeat(400)}.example:443 (private)`];
    const summary = summarizeRun(outcome(blocked), [], skipped);
    for (const text of [...summary.skipped_files, ...summary.blocked_requests]) {
      assert.ok(text.isWellFormed(), "no lone surrogate");
      assert.ok(Array.from(text).length <= 300);
    }
    assert.ok(JSON.stringify(summary).indexOf("\\ud") === -1, "no escaped surrogate in the JSON");
  });

  it("fits with the most files the database keeps, names of control characters, and huge blocked entries", () => {
    const files = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(200, "f"));
    const skipped = Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(3771, "\u0001"));
    const blocked = Array.from({ length: 60 }, (_, i) => `${i}`.padEnd(19000, "\u0001"));
    const summary = summarizeRun(outcome(blocked), files, skipped);
    assert.ok(asJsonb(summary) <= 65536, `${asJsonb(summary)} bytes`);
    assert.ok(bytes(summary) <= 48 * 1024, `within the 48 KiB budget, which leaves room for jsonb's spacing: ${bytes(summary)} bytes (R6.1)`);
    assert.equal(summary.files.length, 200, "every kept file is still listed, for its download");
    assert.equal(summary.skipped_count, 25);
    assert.ok(summary.skipped_files.length >= 1, "at least one left-out file is still named");
    assert.ok(summary.blocked_requests.length >= 1, "and some blocked requests, each cut");
    assert.ok(summary.blocked_requests.every((entry) => entry.length <= 300));
  });
});

describe("the run process's output is checked before it is used (R6.2)", () => {
  const good = { journey: "targets/x.journey.js", name: "X", mode: "walker", status: "pass", error: null, checks_total: 2, checks_passed: 2, errors: 0, warnings: 1, report_base: "x.walker" };
  const JOB = { journeys: [{ path: good.journey, file: "unused" }], modes: ["walker", "virtual"] };
  /**
   * Run a probe in place of run-child.js: it reads the job on stdin, writes `output` to its
   * stdout, then sends `messages` on fd 3 as JSON lines (or `raw` text instead), and exits.
   * Resolves to executeRun's outcome, and the lines it logged.
   */
  const probe = async (messages, { job = JOB, output = "", raw = null } = {}) => {
    const folder = await mkdtemp(join(tmpdir(), "srj-probe-"));
    try {
      const file = join(folder, "probe.mjs");
      const text = raw ?? messages.map((m) => `${JSON.stringify(m)}\n`).join("");
      await writeFile(
        file,
        `import { createWriteStream } from "node:fs";
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  process.stdout.write(${JSON.stringify(output)});
  const out = createWriteStream("", { fd: 3 });
  out.end(${JSON.stringify(text)}, () => process.exit(0));
});
`
      );
      const lines = [];
      const outcome = await executeRun(job, { timeoutMs: 10000, child: file, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) } });
      return Object.assign(outcome, { lines });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };

  it("takes well-formed results and refusals, and cuts long refusals", async () => {
    const outcome = await probe([{ type: "result", result: good, blocked: ["a.example:443 (private)", "b".repeat(5000)] }, { type: "done" }]);
    assert.equal(outcome.outcome, "done");
    assert.deepEqual(outcome.results, [good]);
    assert.deepEqual(outcome.blocked.map((b) => b.length), [23, 2000]);
  });

  for (const [what, message] of [
    ["refusals that are not a list (this crashed the server)", { type: "result", result: good, blocked: {} }],
    ["a refusal that is not a string", { type: "result", result: good, blocked: [null] }],
    ["a refusal with a huge length", { type: "result", result: good, blocked: [{ length: 5e7 }] }],
    ["a count that is not a number", { type: "result", result: { ...good, errors: "999" } }],
    ["a negative count", { type: "result", result: { ...good, warnings: -1 } }],
    ["more checks passed than made", { type: "result", result: { ...good, checks_passed: 3 } }],
    ["a status it does not know", { type: "result", result: { ...good, status: "great" } }],
    ["no result", { type: "result" }],
    ["an error that is not text", { type: "error", message: { toString: 1 } }],
    ["a message of no known type", { type: "surprise" }],
    ["a count over the ceiling", { type: "result", result: { ...good, warnings: 1_000_001 } }],
    ["a result for a journey the job does not have (R7.5)", { type: "result", result: { ...good, journey: "x\ud800\u0000.yml" } }],
    ["a result for a mode the job does not have (R7.5)", { type: "result", result: { ...good, mode: "zzz" } }],
  ]) {
    it(`ends the run as an error on ${what}`, async () => {
      const outcome = await probe([message, { type: "done" }]);
      assert.equal(outcome.outcome, "error");
      assert.equal(outcome.error, "The run process sent a malformed message.");
      assert.deepEqual(outcome.results, []);
    });
  }

  it("refuses a message over the size limit, one still growing past it, and one that is not JSON (R7.5)", async () => {
    for (const [what, raw] of [
      ["an over-long line", `${JSON.stringify({ type: "error", message: "m".repeat(MAX_MESSAGE + 10) })}\n`],
      ["a line that keeps growing", "x".repeat(MAX_MESSAGE + 10)],
      ["a line that is not JSON", "{not json\n"],
      ["a line of 300,000 characters, over the 256 KB limit (R8.4)", `${JSON.stringify({ type: "error", message: "m".repeat(300_000) })}\n`],
    ]) {
      const outcome = await probe([], { raw });
      assert.equal(outcome.outcome, "error", what);
      assert.equal(outcome.error, "The run process sent a malformed message.", what);
    }
  });

  /** Run `source` as the run process (it gets the job on stdin and writes JSON lines to fd 3). */
  const runSource = async (source, options = {}) => {
    const folder = await mkdtemp(join(tmpdir(), "srj-probe-"));
    try {
      const file = join(folder, "probe.mjs");
      await writeFile(file, `import { createWriteStream } from "node:fs";\nimport { spawn } from "node:child_process";\nconst out = createWriteStream("", { fd: 3 });\nconst send = (m) => out.write(JSON.stringify(m) + "\\n");\nconst GOOD = ${JSON.stringify(good)};\n${source}\n`);
      const lines = [];
      const outcome = await executeRun(JOB, { timeoutMs: 10000, child: file, log: { log: (m) => lines.push(m), error: (m) => lines.push(m) }, ...options });
      return Object.assign(outcome, { lines, folder });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  };

  it("takes the refusals sent on their own at the end of a job or at a stop (R9.3)", async () => {
    const limit = "all connections (byte limit: the run moved its 100 MB through the network guard)";
    const outcome = await probe([{ type: "result", result: good, blocked: ["a.example:443 (private)"] }, { type: "blocked", blocked: [limit] }, { type: "done" }]);
    assert.equal(outcome.outcome, "done");
    assert.deepEqual(outcome.blocked, ["a.example:443 (private)", limit]);
    const bad = await probe([{ type: "blocked", blocked: {} }, { type: "done" }]);
    assert.equal(bad.error, "The run process sent a malformed message.");
  });

  it("keeps at most MAX_BLOCKED different refusals, however many are sent, and one byte-limit entry (R20.1-1)", async () => {
    const limit = (n) => `all connections (byte limit: the run moved its ${n} MB through the network guard)`;
    const batch = (from) => Array.from({ length: 100 }, (_, i) => `h${from + i}.example:443 (private)`);
    const messages = [
      { type: "result", result: good, blocked: batch(0) },
      ...[0, 0, 100, 200, 300, 400].map((from) => ({ type: "blocked", blocked: batch(from) })),
      // After the cap is full: the byte limit is still kept, once.
      { type: "blocked", blocked: [limit(100), limit(1), "late.example:443 (private)"] },
      { type: "blocked", blocked: [limit(2)] },
      { type: "done" },
    ];
    const outcome = await probe(messages);
    assert.equal(outcome.outcome, "done");
    assert.equal(outcome.blocked.length, MAX_BLOCKED + 1);
    assert.deepEqual(outcome.blocked.slice(0, MAX_BLOCKED), [...batch(0), ...batch(100)], "the first different ones, each once");
    assert.deepEqual(outcome.blocked.filter((e) => e.startsWith("all connections")), [limit(100)]);
  });

  it("keeps only the fields of a result that the worker uses (R8.4)", async () => {
    const outcome = await probe([{ type: "result", result: { ...good, x: Array.from({ length: 1000 }, () => ({})) } }, { type: "done" }]);
    assert.equal(outcome.outcome, "done");
    assert.deepEqual(outcome.results, [good]);
  });

  it("stops reading once the process says it is done (R8.4)", async () => {
    const outcome = await probe([], { raw: `${JSON.stringify({ type: "done" })}\n{not json\n${"x".repeat(MAX_MESSAGE + 10)}` });
    assert.deepEqual([outcome.outcome, outcome.error], ["done", null], "what came after done was never parsed");
  });

  it("still takes a result already on its way when the time is up, until the process ends (R8.5)", async () => {
    const outcome = await runSource('process.on("SIGTERM", () => out.end(JSON.stringify({ type: "result", result: GOOD }) + "\\n", () => process.exit(0)));\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);', { timeoutMs: 200 });
    assert.equal(outcome.outcome, "timeout");
    assert.deepEqual(outcome.results, [good]);
  });

  it("kills a process that ignores SIGTERM (R8.5)", { timeout: 10000 }, async () => {
    const outcome = await runSource('process.on("SIGTERM", () => {});\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);', { timeoutMs: 200, killAfterMs: 200 });
    assert.equal(outcome.outcome, "timeout");
  });

  it("settles a moment after the process exits, even if something it started holds its pipes (R8.5)", { timeout: 10000 }, async () => {
    const pidFile = join(tmpdir(), `srj-grandchild-${process.pid}-${Date.now()}`);
    try {
      const outcome = await runSource(
        `const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ["ignore", "inherit", "inherit", "inherit"] });\ng.unref();\n(await import("node:fs")).writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));\nprocess.stdin.resume();\nprocess.stdin.on("end", () => out.write(JSON.stringify({ type: "done" }) + "\\n", () => process.exit(0)));`
      );
      assert.equal(outcome.outcome, "done");
    } finally {
      const { readFileSync: read, rmSync } = await import("node:fs");
      try {
        process.kill(Number(read(pidFile, "utf8")), "SIGKILL");
      } catch {
        // already gone
      }
      rmSync(pidFile, { force: true });
    }
  });

  it("takes a large last message written just before the process exits (R8.5)", async () => {
    const outcome = await runSource('process.stdin.resume();\nprocess.stdin.on("end", () => { send({ type: "result", result: { ...GOOD, error: "e".repeat(90_000) } }); out.end(JSON.stringify({ type: "done" }) + "\\n", () => process.exit(0)); });');
    assert.equal(outcome.outcome, "done");
    assert.equal(outcome.results.length, 1);
    assert.equal(outcome.results[0].error.length, 90_000);
  });

  it("takes messages until the pipes close, not only until the process exits (R8.5)", { timeout: 10000 }, async () => {
    // The process exits at once; what it started writes the result and "done" 300 ms later.
    const later = `setTimeout(() => { const o = require("node:fs").createWriteStream("", { fd: 3 }); o.write(JSON.stringify({ type: "result", result: ${JSON.stringify(good)} }) + "\\n"); o.end(JSON.stringify({ type: "done" }) + "\\n"); }, 300)`;
    const outcome = await runSource(`spawn(process.execPath, ["-e", ${JSON.stringify(later)}], { stdio: ["ignore", "ignore", "ignore", "inherit"] });\nprocess.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));`);
    assert.equal(outcome.outcome, "done", String(outcome.error));
    assert.deepEqual(outcome.results, [good]);
  });

  it("allows 1000 log lines a run, stdout and stderr together (R8.6)", async () => {
    const outcome = await runSource('for (let i = 0; i < 600; i++) { process.stdout.write("o\\n"); process.stderr.write("e\\n"); }\nprocess.stdin.resume();\nprocess.stdin.on("end", () => out.end(JSON.stringify({ type: "done" }) + "\\n", () => setTimeout(() => process.exit(0), 50)));');
    const relayed = outcome.lines.filter((m) => m.startsWith("run process:"));
    assert.equal(relayed.length, 1001);
    assert.equal(relayed.filter((m) => /more than 1000 lines/.test(m)).length, 1);
  });

  it("takes one result for each journey and mode, and none twice (R7.5)", async () => {
    const twice = await probe([{ type: "result", result: good }, { type: "result", result: good }, { type: "done" }]);
    assert.equal(twice.outcome, "error");
    assert.equal(twice.error, "The run process sent a malformed message.");
    assert.deepEqual(twice.results, [good], "only the first");
    const both = await probe([{ type: "result", result: good }, { type: "result", result: { ...good, mode: "virtual" } }, { type: "done" }]);
    assert.equal(both.outcome, "done");
    assert.equal(both.results.length, 2);
  });

  it("takes nothing after a malformed message, or after it said it was done or failed (R7.5)", async () => {
    const afterBad = await probe([{ type: "surprise" }, { type: "result", result: good }, { type: "error", message: "a later error" }]);
    assert.deepEqual([afterBad.outcome, afterBad.error, afterBad.results], ["error", "The run process sent a malformed message.", []]);
    const afterDone = await probe([{ type: "done" }, { type: "result", result: good }]);
    assert.deepEqual([afterDone.outcome, afterDone.results], ["done", []]);
    const afterError = await probe([{ type: "error", message: "first" }, { type: "error", message: "second" }, { type: "result", result: good }]);
    assert.deepEqual([afterError.outcome, afterError.error, afterError.results], ["error", "first", []]);
  });

  it("keeps at most 100,000 characters of the process's error (R7.5)", async () => {
    const outcome = await probe([{ type: "error", message: "e".repeat(200_000) }]);
    assert.equal(outcome.error.length, 100_000);
  });

  it("logs the process's own output quoted, one line at a time, cut and bounded (R7.5)", async () => {
    const output = `one\nrun 1: done (forged)\n${"z".repeat(3000)}\n${"n\n".repeat(1100)}`;
    const { lines } = await probe([{ type: "done" }], { output });
    const relayed = lines.filter((m) => m.startsWith("run process:"));
    assert.equal(relayed[0], 'run process: "one"');
    assert.equal(relayed[1], 'run process: "run 1: done (forged)"', "quoted, so it cannot pass for a line of the server's");
    assert.ok(relayed[2].endsWith('" (cut)') && relayed[2].length < 2100, relayed[2].slice(-40));
    assert.equal(relayed.length, 1001);
    assert.match(relayed.at(-1), /more than 1000 lines; the rest is not logged/);
    assert.ok(lines.every((m) => !m.includes("\n")));
  });

  it("stores only well-formed text: no lone surrogate and no NUL in names, refusals or errors", () => {
    const summary = summarizeRun({ results: [], blocked: ["host\u0000.example:443 (private)", "\ud800x.example:443 (private)"], outcome: "done" }, [], ["\ud800.md", "a\u0000b.md"]);
    for (const text of [...summary.skipped_files, ...summary.blocked_requests]) {
      assert.ok(text.isWellFormed() && !text.includes("\u0000"), JSON.stringify(text));
    }
    assert.deepEqual(summary.skipped_files, ["\uFFFD.md", "a\uFFFDb.md"]);
    const long = summarizeRun({ results: [], blocked: ["z".repeat(10_000_000)], outcome: "done" }, [], []);
    assert.equal(Array.from(long.blocked_requests[0]).length, 300, "a huge entry is cut from a bounded slice");
  });
});

describe("run-child.js, with \"*\" or a wildcard (R8.2)", () => {
  it("refuses a job without Chromium's sandbox, before starting anything", async () => {
    const { runJob } = await import("../server/run-child.js");
    for (const hosts of ["*", "*.vercel.app"]) {
      await assert.rejects(runJob({ allowedTargetHosts: hosts, chromiumSandbox: false, journeys: [], modes: [] }, () => {}), /needs Chromium's sandbox/, hosts);
    }
  });
});

describe("run-child.js sends the refusals left at the end (R9.3)", () => {
  it("sends what the proxy refused after the last result, the byte limit tripping as it closes included", async () => {
    const { runJob } = await import("../server/run-child.js");
    const limit = "all connections (byte limit: the run moved its 100 MB through the network guard)";
    const proxy = { server: "http://127.0.0.1:1", blocked: ["late.example:443 (private)"], close: async () => proxy.blocked.unshift(limit) };
    const sent = [];
    let told = null;
    await runJob({ allowedTargetHosts: "", journeys: [], modes: [] }, (m) => sent.push(m), { startProxy: async () => proxy, onProxy: (p) => (told = p) });
    assert.deepEqual(sent, [{ type: "blocked", blocked: [limit, "late.example:443 (private)"] }]);
    assert.equal(told, proxy, "the main block can send what is left at a stop");
  });

  it("at a stop, sends what is left at once and what came since before exiting, then exits once written (R20.1-3)", async () => {
    const { stopSoon } = await import("../server/run-child.js");
    const proxy = { blocked: ["a.example:443 (private)"] };
    const sent = [];
    const out = { writableEnded: false, ends: 0, end(done) {
      this.writableEnded = true;
      this.ends++;
      setImmediate(done);
    } };
    // stopSoon's timers are unref'd, as the run process's own work keeps it alive; here, this does.
    const alive = setInterval(() => {}, 1000);
    after(() => clearInterval(alive));
    const exited = new Promise((resolve) => stopSoon(() => proxy, (m) => sent.push(m), out, resolve, 20));
    assert.deepEqual(sent, [{ type: "blocked", blocked: ["a.example:443 (private)"] }], "sent at once");
    proxy.blocked.push("all connections (byte limit: the run moved its 100 MB through the network guard)");
    assert.equal(await exited, 143);
    assert.deepEqual(sent[1], { type: "blocked", blocked: ["all connections (byte limit: the run moved its 100 MB through the network guard)"] }, "the one made since");
    assert.equal(out.ends, 1, "the messages are ended before the exit");

    // Messages already ended (the job's own end came first): it still exits, without ending again.
    const ended = { writableEnded: true, ends: 0, end() {
      this.ends++;
    } };
    assert.equal(await new Promise((resolve) => stopSoon(() => null, () => {}, ended, resolve, 0)), 143);
    assert.equal(ended.ends, 0);
    clearInterval(alive);
  });

  it("writes nothing once the messages have ended (R20.1-3)", async () => {
    const { sender } = await import("../server/run-child.js");
    const lines = [];
    const out = { writableEnded: false, write: (line) => lines.push(line) };
    const send = sender(out);
    send({ type: "done" });
    out.writableEnded = true;
    send({ type: "blocked", blocked: ["x"] });
    assert.deepEqual(lines, ['{"type":"done"}\n']);
  });

  it("a stopped run keeps the refusals of the journey it was in, through the real run process (R20.1-2)", async () => {
    const folder = await mkdtemp(join(tmpdir(), "srj-stop-"));
    // Stopped once the page's private address has been refused (the page then asks for /after)
    // and the journey's run() has begun (it asks for /in-run itself), so no result can carry it.
    const reached = { after: null, "in-run": null };
    const both = Promise.all(Object.keys(reached).map((name) => new Promise((resolve) => (reached[name] = resolve))));
    const site = createServer((req, res) => {
      const name = req.url?.slice(1) ?? "";
      if (name in reached) return reached[name](), res.end("ok");
      if (req.url !== "/private.html") return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/html" }).end('<!doctype html><title>Private</title><img alt="" src="http://169.254.169.254/srj.png" onerror="fetch(\'/after\')">');
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    try {
      const file = join(folder, "hang-private.journey.js");
      const host = `127.0.0.1:${site.address().port}`;
      await writeFile(file, `export default { name: "Stopped after a refusal", start: "/private.html", async run() { await fetch("http://${host}/in-run"); await new Promise(() => {}); } };\n`);
      const job = { baseUrl: `http://${host}/`, journeys: [{ path: "x/hang-private.journey.js", file }], modes: ["walker"], outDir: join(folder, "out"), allowedTargetHosts: host, chromiumSandbox: false };
      const stop = new AbortController();
      both.then(() => stop.abort());
      const outcome = await executeRun(job, { timeoutMs: 60000, signal: stop.signal, log: quiet });
      assert.equal(outcome.outcome, "aborted");
      assert.deepEqual(outcome.results, [], "the journey never finished, so only the stop could send it");
      assert.ok(outcome.blocked.some((e) => e.startsWith("169.254.169.254:80 ")), JSON.stringify(outcome.blocked));
    } finally {
      site.close();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("sends nothing when nothing is left, or no proxy has started", async () => {
    const { sendLeftover } = await import("../server/run-child.js");
    const sent = [];
    sendLeftover(null, (m) => sent.push(m));
    sendLeftover({ blocked: [] }, (m) => sent.push(m));
    assert.deepEqual(sent, []);
  });
});

describe("probeSandbox (R7.1)", () => {
  const program = async (source) => {
    const folder = await mkdtemp(join(tmpdir(), "srj-sbx-"));
    const file = join(folder, "probe.mjs");
    await writeFile(file, source);
    return { file, done: () => rm(folder, { recursive: true, force: true }) };
  };

  it("is null when the probe opened a sandboxed page, and the probe's reason when not", async () => {
    const ok = await program("process.exit(0);\n");
    const no = await program('process.stdout.write("No usable sandbox! Update your kernel\\nmore\\n"); process.exit(1);\n');
    try {
      assert.equal(await probeSandbox(null, { program: ok.file }), null);
      assert.equal(await probeSandbox(null, { program: no.file }), "No usable sandbox! Update your kernel");
    } finally {
      await ok.done();
      await no.done();
    }
  });

  it("probe() opens a page in a Chromium started with its sandbox, and closes it", async () => {
    const { probe } = await import("../server/sandbox-probe.js");
    const calls = [];
    const browser = { newPage: async () => ({ setContent: async (html) => calls.push(["page", html]) }), close: async () => calls.push(["close"]) };
    await probe({ launch: async (options) => (calls.push(["launch", options]), browser) });
    assert.deepEqual(calls, [["launch", { chromiumSandbox: true, timeout: 20000 }], ["page", "<p>sandboxed</p>"], ["close"]]);
    await assert.rejects(probe({ launch: async () => Promise.reject(new Error("No usable sandbox!")) }), /No usable sandbox/);
  });

  it("ends a probe that hangs, and says so", async () => {
    const hang = await program("setInterval(() => {}, 1000);\n");
    try {
      assert.equal(await probeSandbox(null, { program: hang.file, timeoutMs: 200 }), "the probe ended (SIGKILL)");
    } finally {
      await hang.done();
    }
  });

  const root = process.getuid?.() === 0;
  it("with the real Chromium, as the run's user, answers and leaves nothing running", { skip: !root && "needs root, as in the Docker image" }, async () => {
    const answer = await probeSandbox({ uid: 10001, gid: 10001 });
    assert.ok(answer === null || (typeof answer === "string" && answer.length > 0), String(answer));
    const { stopUserProcesses, processesOf } = await import("../server/reports.js");
    await stopUserProcesses(10001);
    assert.deepEqual(await processesOf(10001), []);
  });
});

describe("run process environment", () => {
  it("passes only a short list of harmless variables", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/home/x", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_ANON_KEY: "a", WORKER_TOKEN: "w", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", DB_PASSWORD: "p", DATABASE_URL: "postgres://u:p@h/db", RENDER_API: "x", PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: "1" });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH"]);
    assert.equal(childEnv({ HOME: "/root" }, { HOME: "/tmp/run/home" }).HOME, "/tmp/run/home");
  });

  it("starts the run process without the server's node flags, so a .env it was started with stays out", async () => {
    // A server started as `node --env-file-if-exists=.env` (npm run server:dev) has the file's
    // variables, and fork would pass the flag on: the run process would read .env itself.
    const folder = await mkdtemp(join(tmpdir(), "srj-execargv-"));
    try {
      await writeFile(join(folder, ".env"), "SRJ_PROBE_FROM_DOTENV=leaked\n");
      const probe = join(folder, "probe.mjs");
      // It reports through an "error" message, the one kind that carries free text.
      await writeFile(
        probe,
        'import { createWriteStream } from "node:fs";\nprocess.stdin.resume();\nprocess.stdin.on("end", () => createWriteStream("", { fd: 3 }).end(JSON.stringify({ type: "error", message: JSON.stringify({ execArgv: process.execArgv, fromDotenv: process.env.SRJ_PROBE_FROM_DOTENV ?? null }) }) + "\\n", () => process.exit(0)));\n'
      );
      const execute = new URL("../server/execute.js", import.meta.url).href;
      const parent = `import(${JSON.stringify(execute)}).then(async ({ executeRun }) => { const r = await executeRun({}, { timeoutMs: 10000, child: ${JSON.stringify(probe)} }); console.log(JSON.stringify(r)); });`;
      const { stdout } = await promisify(execFile)(process.execPath, ["--env-file-if-exists=.env", "--input-type=module", "-e", parent], { cwd: folder, env: { PATH: process.env.PATH } });
      const outcome = JSON.parse(stdout.trim().split("\n").pop());
      assert.equal(outcome.outcome, "error", stdout);
      assert.deepEqual(JSON.parse(outcome.error), { execArgv: [], fromDotenv: null });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  const root = process.getuid?.() === 0;
  it("as another user, cannot read the server's environment", { skip: !root && "needs root, as in the Docker image" }, async () => {
    const probe = "try { require('fs').readFileSync('/proc/' + process.ppid + '/environ'); console.log('read'); } catch (e) { console.log(e.code); }";
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", probe], { uid: 10001, gid: 10001, env: childEnv(), cwd: "/" });
    assert.equal(stdout.trim(), "EACCES");
  });

  it("as another user, still runs the journeys and saves the reports", { skip: !root && "needs root, as in the Docker image" }, async () => {
    const site = await serve(fixtures);
    try {
      const run = queued({ base_url: `${site.url}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      // A failed stop must show as a failed assertion here, not end the test file.
      const exits = [];
      let outDir;
      const execute = (job, options) => {
        outDir = job.outDir;
        return executeRun(job, options);
      };
      await createWorker({ db: dbOf(fake), catalog, config: configFor(new URL(site.url).host, { runAs: { uid: 10001, gid: 10001 } }), execute, log: quiet, exit: (code) => exits.push(code) }).tick();
      assert.deepEqual(exits, []);
      assert.equal(fake.run(run.id).status, "done", fake.run(run.id).error);
      assert.ok(fake.report(run.id, "basic-test-page.walker.md"));
      assert.ok(!fake.tables.run_reports.some((r) => r.path.includes("home/")), "the browser's own files are not saved");
      assert.ok(!existsSync(join(outDir, "..")), "the work folder is gone, emptied as the run's user");
    } finally {
      site.close();
    }
  });
});

describe("shutting down", () => {
  const HOST = "good.example.org";
  const config = configFor(HOST);
  const lookup = async () => ["76.76.21.21"];

  it("does not claim a run once stopping", async () => {
    const fake = fakeSupabase({ runs: [queued({ base_url: `https://${HOST}/`, journeys: [BASIC] })] });
    const worker = createWorker({ db: dbOf(fake), catalog, config, execute: async () => assert.fail("must not run"), lookup, log: quiet });
    await worker.stop();
    assert.equal(await worker.tick(), false);
    assert.ok(!fake.calls.some((c) => c.name === "worker_claim_next_run"));
  });

  it("puts back a run claimed while it was stopping, without running it", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const rpc = fake.rpc;
    let claiming;
    const claimed = new Promise((resolve) => (claiming = resolve));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    fake.rpc = async (name, args) => {
      if (name === "worker_claim_next_run") {
        claiming();
        await gate;
      }
      return rpc(name, args);
    };
    let sawAbort = null;
    const execute = async (job, { signal }) => {
      sawAbort = signal.aborted;
      return { outcome: signal.aborted ? "aborted" : "done", error: null, results: [], blocked: [] };
    };
    const worker = createWorker({ db: dbOf(fake), catalog, config, execute, lookup, log: quiet });
    const ticking = worker.tick();
    await claimed;
    await worker.stop();
    release();
    await ticking;
    assert.equal(sawAbort, true);
    assert.equal(fake.run(run.id).status, "queued");
  });
});

describe("Supabase requests", () => {
  it("give up after the time limit", async () => {
    const hang = (input, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    // AbortSignal.timeout does not keep Node running by itself (the server's HTTP listener does).
    const keepAlive = setTimeout(() => {}, 5000);
    const started = Date.now();
    try {
      await assert.rejects(timeoutFetch(50, hang)("https://example.invalid/"), { name: "TimeoutError" });
    } finally {
      clearTimeout(keepAlive);
    }
    assert.ok(Date.now() - started < 2000);
  });

  it("still honour the caller's own signal", async () => {
    const hang = (input, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const controller = new AbortController();
    const pending = timeoutFetch(60000, hang)("https://example.invalid/", { signal: controller.signal });
    controller.abort(new Error("caller stopped"));
    await assert.rejects(pending, /caller stopped/);
  });
});
