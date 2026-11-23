// The hosted server's worker, with a fake Supabase client. The end-to-end tests run real
// journeys in Chromium against local fixture sites, with the allowlist set to 127.0.0.1.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadCatalog, REPO_ROOT } from "../server/catalog.js";
import { childEnv } from "../server/execute.js";
import { timeoutFetch } from "../server/timeout-fetch.js";
import { parseAllowedHosts } from "../server/hosts.js";
import { createWorker } from "../server/worker.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";
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
const queued = (fields) => ({ id: randomUUID(), created_by: USER, status: "queued", modes: ["walker"], ...fields });

describe("worker, end to end", () => {
  let site;
  before(async () => {
    site = await serve(fixtures);
  });
  after(() => site.close());

  it("claims a run, runs it, uploads the reports and records the results", async () => {
    const run = queued({ base_url: `${site.url}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const worker = createWorker({ admin: fake, catalog, config: configFor(new URL(site.url).host), log: quiet });

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
    assert.equal(result.report_path, `${run.id}/basic-test-page.walker.md`);

    const uploaded = [...fake.uploads.keys()].sort();
    assert.deepEqual(
      uploaded,
      ["basic-test-page.walker.html", "basic-test-page.walker.json", "basic-test-page.walker.md", "summary.html", "summary.md"].map((f) => `reports/${run.id}/${f}`)
    );
    assert.equal(fake.uploads.get(`reports/${run.id}/summary.html`).options.contentType, "text/html; charset=utf-8");
    const report = fake.uploads.get(`reports/${run.id}/basic-test-page.walker.md`);
    assert.equal(report.options.contentType, "text/markdown; charset=utf-8");
    assert.match(report.body.toString(), /\| Tab \| Save, button \|/);
    assert.equal(JSON.parse(fake.uploads.get(`reports/${run.id}/basic-test-page.walker.json`).body).status, "pass");

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
      await createWorker({ admin: fake, catalog, config: configFor(host), log: quiet }).tick();
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
      await createWorker({ admin: fake, catalog, config: configFor(new URL(site.url).host, { runTimeoutMs: 8000 }), log: quiet }).tick();
      assert.ok(Date.now() - started < 30000);
      const saved = fake.run(run.id);
      assert.equal(saved.status, "failed");
      assert.match(saved.error, /Timed out after 8 seconds; 1 of 2 journey runs finished/);
      assert.equal(saved.summary.timed_out, true);
      assert.deepEqual(fake.tables.run_results.map((r) => r.journey), [BASIC], "the journey that finished is kept");
      assert.ok(fake.uploads.has(`reports/${run.id}/basic-test-page.walker.md`));

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
  const config = configFor("*.vercel.app");
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
      await createWorker({ admin: fake, catalog, config, execute: executeNothing, lookup, log: quiet }).tick();
      assert.equal(fake.run(run.id).status, "failed");
      assert.match(fake.run(run.id).error, message);
      assert.equal(fake.uploads.size, 0);
    });
  }

  it("refuses an allowed host that resolves to a private address", async () => {
    const run = queued({ base_url: "https://evil.vercel.app/", journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    await createWorker({ admin: fake, catalog, config, execute: executeNothing, lookup: async () => ["10.0.0.5"], log: quiet }).tick();
    assert.match(fake.run(run.id).error, /Refused: evil\.vercel\.app resolves to 10\.0\.0\.5/);
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
    await createWorker({ admin: fake, catalog, config, execute, lookup, log: quiet }).tick();
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
    await createWorker({ admin: fake, catalog, config, execute, lookup, log: quiet }).tick();
    assert.equal(fake.run(run.id).status, "failed");
    assert.match(fake.run(run.id).error, /Executable doesn't exist/);
  });

  it("marks a run failed when saving its results fails, rather than leaving it running", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    fake.failures.push({ op: "insert", table: "run_results", error: { message: "connection reset" } });
    const execute = async () => ({ outcome: "done", error: null, results: [summary(BASIC, "walker")], blocked: [] });
    const logged = [];
    await createWorker({ admin: fake, catalog, config, execute, lookup, log: { log() {}, error: (line) => logged.push(line) } }).tick();
    assert.equal(fake.run(run.id).status, "failed");
    // The user sees a plain sentence; the database's message goes to the log only.
    assert.match(fake.run(run.id).error, /^The server could not finish this run\./);
    assert.doesNotMatch(fake.run(run.id).error, /connection reset/);
    assert.ok(logged.some((line) => /saving results: connection reset/.test(line)), logged.join("\n"));
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
    const worker = createWorker({ admin: fake, catalog, config, execute, lookup, log: quiet });
    worker.start();
    await running;
    assert.equal(worker.busy, true);
    await worker.stop();
    assert.equal(fake.run(run.id).status, "queued");
    assert.equal(fake.run(run.id).started_at, null);
  });

  it("fails runs left running by a server that stopped", async () => {
    const old = queued({ base_url: `https://${HOST}/`, journeys: [BASIC], status: "running", started_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString() });
    const recent = queued({ base_url: `https://${HOST}/`, journeys: [BASIC], status: "running", started_at: new Date().toISOString() });
    const fake = fakeSupabase({ runs: [old, recent] });
    assert.equal(await createWorker({ admin: fake, catalog, config, execute: executeNothing, lookup, log: quiet }).tick(), false);
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
    const worker = createWorker({ admin: fake, catalog, config, execute: executeNothing, lookup, log: { log() {}, error: (m) => errors.push(m) } });
    worker.start();
    await new Promise((r) => setTimeout(r, 300));
    await worker.stop();
    assert.ok(claims >= 2, `polled ${claims} times`);
    assert.match(errors[0], /claim_next_run: upstream unavailable/);
  });
});

describe("run process environment", () => {
  it("passes only a short list of harmless variables", () => {
    const env = childEnv({ PATH: "/bin", HOME: "/home/x", PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright", SUPABASE_URL: "u", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_ANON_KEY: "a", GITHUB_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", DB_PASSWORD: "p", DATABASE_URL: "postgres://u:p@h/db", RENDER_API: "x", PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK: "1" });
    assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH", "PLAYWRIGHT_BROWSERS_PATH"]);
    assert.equal(childEnv({ HOME: "/root" }, { HOME: "/tmp/run/home" }).HOME, "/tmp/run/home");
  });

  const root = process.getuid?.() === 0;
  it("as another user, cannot read the server's environment", { skip: !root && "needs root, as in the Docker image" }, async () => {
    const probe = "try { require('fs').readFileSync('/proc/' + process.ppid + '/environ'); console.log('read'); } catch (e) { console.log(e.code); }";
    const { stdout } = await promisify(execFile)(process.execPath, ["-e", probe], { uid: 10001, gid: 10001, env: childEnv(), cwd: "/" });
    assert.equal(stdout.trim(), "EACCES");
  });

  it("as another user, still runs the journeys and uploads the reports", { skip: !root && "needs root, as in the Docker image" }, async () => {
    const site = await serve(fixtures);
    try {
      const run = queued({ base_url: `${site.url}/`, journeys: [BASIC] });
      const fake = fakeSupabase({ runs: [run] });
      await createWorker({ admin: fake, catalog, config: configFor(new URL(site.url).host, { runAs: { uid: 10001, gid: 10001 } }), log: quiet }).tick();
      assert.equal(fake.run(run.id).status, "done", fake.run(run.id).error);
      assert.ok(fake.uploads.has(`reports/${run.id}/basic-test-page.walker.md`));
      assert.ok(![...fake.uploads.keys()].some((k) => k.includes("/home/")), "the browser's own files are not uploaded");
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
    const worker = createWorker({ admin: fake, catalog, config, execute: async () => assert.fail("must not run"), lookup, log: quiet });
    await worker.stop();
    assert.equal(await worker.tick(), false);
    assert.ok(!fake.calls.some((c) => c.op === "rpc"));
  });

  it("puts back a run claimed while it was stopping, without running it", async () => {
    const run = queued({ base_url: `https://${HOST}/`, journeys: [BASIC] });
    const fake = fakeSupabase({ runs: [run] });
    const rpc = fake.rpc;
    let claiming;
    const claimed = new Promise((resolve) => (claiming = resolve));
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    fake.rpc = async (name) => {
      claiming();
      await gate;
      return rpc(name);
    };
    let sawAbort = null;
    const execute = async (job, { signal }) => {
      sawAbort = signal.aborted;
      return { outcome: signal.aborted ? "aborted" : "done", error: null, results: [], blocked: [] };
    };
    const worker = createWorker({ admin: fake, catalog, config, execute, lookup, log: quiet });
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
