// The hosted server's input validation, journey whitelist, settings and HTTP API, with a fake
// Supabase client (no network beyond 127.0.0.1).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { findJourney, loadCatalog } from "../server/catalog.js";
import { loadConfig } from "../server/config.js";
import { parseAllowedHosts } from "../server/hosts.js";
import { createHandler } from "../server/http.js";
import { isUuid, validateRunRequest } from "../server/validate.js";
import { fakeSupabase } from "./helpers/fake-supabase.js";

const HOME = "targets/generic/home-tab-order.journey.js";
const BRAILLE = "targets/stem-accessibility/journeys/braille-download.journey.js";
let catalog;
before(async () => {
  catalog = await loadCatalog();
});
const rules = parseAllowedHosts("*.vercel.app");
const validate = (body) => validateRunRequest(body, { catalog, rules });

describe("journey whitelist", () => {
  it("lists the journeys in targets/ by repo-relative path, with their names", () => {
    const paths = catalog.map((j) => j.path);
    assert.ok(paths.includes(HOME), paths.join(", "));
    assert.ok(paths.includes(BRAILLE));
    assert.ok(paths.every((p) => p.startsWith("targets/") && p.endsWith(".journey.js")));
    assert.equal(findJourney(catalog, HOME).name, "Home page: Tab order");
  });

  for (const path of [
    `./${HOME}`,
    `targets/generic/../generic/home-tab-order.journey.js`,
    `/${HOME}`,
    HOME.toUpperCase(),
    `${HOME} `,
    "targets/generic",
    "test/fixtures/basic.journey.js",
    "../../etc/passwd",
    "data:text/javascript,export default {}",
    "https://evil.example/x.journey.js",
    { path: HOME },
    null,
  ]) {
    it(`does not match ${JSON.stringify(path)}`, () => assert.equal(findJourney(catalog, path), null));
  }
});

describe("run request validation", () => {
  it("accepts a valid request and normalizes it", () => {
    const result = validate({ base_url: "https://Preview.Vercel.app", journeys: [HOME, BRAILLE, HOME], modes: ["virtual", "walker", "virtual"], extra: 1 });
    assert.deepEqual(result, { ok: true, value: { base_url: "https://preview.vercel.app/", journeys: [HOME, BRAILLE], modes: ["virtual", "walker"] } });
  });

  it("reports every problem with its field", () => {
    const result = validate({ base_url: "https://evil.example", journeys: [], modes: [] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors.map((e) => e.field), ["base_url", "journeys", "modes"]);
  });

  for (const [body, field, message] of [
    [null, null, /JSON object/],
    [[], null, /JSON object/],
    ["https://x.vercel.app", null, /JSON object/],
    [{ journeys: [HOME], modes: ["walker"] }, "base_url", /Enter the address/],
    [{ base_url: "http://x.vercel.app", journeys: [HOME], modes: ["walker"] }, "base_url", /http is only allowed/],
    [{ base_url: "https://x.vercel.app", journeys: "targets", modes: ["walker"] }, "journeys", /at least one/],
    [{ base_url: "https://x.vercel.app", journeys: ["targets/generic/../../secret.journey.js"], modes: ["walker"] }, "journeys", /not one of this server's journeys/],
    [{ base_url: "https://x.vercel.app", journeys: [42], modes: ["walker"] }, "journeys", /not one of this server's journeys/],
    [{ base_url: "https://x.vercel.app", journeys: Array(500).fill(HOME), modes: ["walker"] }, "journeys", /at most/],
    [{ base_url: "https://x.vercel.app", journeys: [HOME], modes: ["voiceover"] }, "modes", /needs a Mac/],
    [{ base_url: "https://x.vercel.app", journeys: [HOME], modes: ["orca"] }, "modes", /not a mode this server runs/],
    [{ base_url: "https://x.vercel.app", journeys: [HOME], modes: "walker" }, "modes", /at least one/],
  ]) {
    it(`refuses ${JSON.stringify(body)?.slice(0, 90)}`, () => {
      const result = validate(body);
      assert.equal(result.ok, false);
      const error = result.errors.find((e) => e.field === field);
      assert.ok(error, JSON.stringify(result.errors));
      assert.match(error.message, message);
    });
  }

  it("clips long input it echoes back", () => {
    const result = validate({ base_url: "https://x.vercel.app", journeys: ["x".repeat(5000)], modes: ["walker"] });
    assert.ok(result.errors[0].message.length < 200);
  });

  it("recognizes run ids", () => {
    assert.equal(isUuid("3f2a1c9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b"), true);
    assert.equal(isUuid("3f2a1c9e-8b7d-4e6f-9a0b-1c2d3e4f5a6"), false);
    assert.equal(isUuid("../runs"), false);
  });
});

describe("settings", () => {
  const env = { SUPABASE_URL: "https://auth.hintwise.org", SUPABASE_ANON_KEY: "anon", WORKER_TOKEN: "worker-token-for-tests-0123456789abcdef" };

  it("needs the Supabase settings and the worker token, and lists every missing one", () => {
    assert.throws(() => loadConfig({}), (e) => /SUPABASE_URL is not set/.test(e.message) && /SUPABASE_ANON_KEY is not set/.test(e.message) && /WORKER_TOKEN is not set/.test(e.message));
  });

  it("keeps the worker token, and refuses one that is not 32 to 200 printable ASCII characters", () => {
    assert.equal(loadConfig(env).workerToken, env.WORKER_TOKEN);
    assert.equal(loadConfig({ ...env, WORKER_TOKEN: "Zm9vYmFyYmF6cXV4K3Rlc3QvdG9rZW4vMDEyMzQ1Njc=" }).workerToken.length, 44, "openssl rand -base64 32");
    for (const bad of ["short", "x".repeat(201), `${"x".repeat(31)} y`, "\u{1F600}".repeat(20), `${"x".repeat(40)}\u00e9`]) {
      assert.throws(() => loadConfig({ ...env, WORKER_TOKEN: bad }), /WORKER_TOKEN must be 32 to 200 printable ASCII characters/, JSON.stringify(bad));
    }
  });

  it("refuses to start with the service-role key in its environment", () => {
    assert.throws(() => loadConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: "service" }), /SUPABASE_SERVICE_ROLE_KEY is set: remove it/);
    assert.doesNotThrow(() => loadConfig({ ...env, SUPABASE_SERVICE_ROLE_KEY: " " }));
  });

  it("defaults to no origins and no target hosts, so nothing is allowed", () => {
    const config = loadConfig({ ...env, PORT: "" });
    assert.deepEqual(config.allowedOrigins, []);
    assert.deepEqual(config.targetRules, []);
    assert.equal(config.port, 8080);
    assert.equal(config.runTimeoutMs, 900000);
    assert.equal(config.chromiumSandbox, false);
  });

  it("reads origins, hosts, port and timeouts", () => {
    const config = loadConfig({ ...env, ALLOWED_ORIGINS: "https://srj.netlify.app, http://127.0.0.1:5173/", ALLOWED_TARGET_HOSTS: "*.vercel.app", PORT: "10000", RUN_TIMEOUT_SECONDS: "60", CHROMIUM_SANDBOX: "true" });
    assert.deepEqual(config.allowedOrigins, ["https://srj.netlify.app", "http://127.0.0.1:5173"]);
    assert.equal(config.targetRules[0].host, "vercel.app");
    assert.deepEqual(loadConfig({ ...env, ALLOWED_TARGET_HOSTS: "*" }).targetRules.map((r) => [r.text, r.any]), [["*", true]], '"*" is any public site');
    assert.equal(config.port, 10000);
    assert.equal(config.runTimeoutMs, 60000);
    assert.equal(config.chromiumSandbox, true);
  });

  for (const [name, value, message] of [
    ["ALLOWED_ORIGINS", "https://srj.netlify.app/app", /without a path/],
    ["ALLOWED_ORIGINS", "srj.netlify.app", /not a URL/],
    ["ALLOWED_TARGET_HOSTS", "*:443", /ALLOWED_TARGET_HOSTS/],
    ["ALLOWED_TARGET_HOSTS", "*.com", /ALLOWED_TARGET_HOSTS/],
    ["PORT", "abc", /PORT/],
    ["RUN_TIMEOUT_SECONDS", "-1", /RUN_TIMEOUT_SECONDS/],
  ]) {
    it(`refuses ${name}=${value}`, () => assert.throws(() => loadConfig({ ...env, [name]: value }), message));
  }
});

describe("HTTP API", () => {
  const ALICE = { id: "00000000-0000-4000-8000-00000000000a", email: "alice@example.org" };
  const BOB = { id: "00000000-0000-4000-8000-00000000000b", email: "bob@example.org" };
  const ORIGIN = "https://srj.netlify.app";
  let fake;
  let server;
  let base;
  const tokensSeen = [];

  before(async () => {
    fake = fakeSupabase({ users: { "alice-token": ALICE, "bob-token": BOB } });
    const config = { allowedOrigins: [ORIGIN], targetRules: rules };
    const userClient = (token) => {
      tokensSeen.push(token);
      return fake.asUser({ "alice-token": ALICE, "bob-token": BOB }[token].id);
    };
    const handler = createHandler({ config, catalog, auth: fake.auth, userClient, version: "test", log: { error() {} } });
    server = createServer(handler);
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  const call = async (method, path, { token, body, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const goodRun = { base_url: "https://preview.vercel.app", journeys: [HOME], modes: ["walker"] };

  it("GET /health", async () => {
    const response = await call("GET", "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok", version: "test" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  it("GET /journeys lists the catalog, the modes and the allowed hosts", async () => {
    const { status, body } = await call("GET", "/journeys");
    assert.equal(status, 200);
    assert.deepEqual(body.modes, ["walker", "virtual"]);
    assert.deepEqual(body.allowed_hosts, ["*.vercel.app"]);
    const home = body.journeys.find((j) => j.path === HOME);
    assert.deepEqual(Object.keys(home).sort(), ["description", "name", "path"]);
  });

  it("POST /runs needs a valid Supabase token", async () => {
    assert.equal((await call("POST", "/runs", { body: goodRun })).status, 401);
    assert.equal((await call("POST", "/runs", { body: goodRun, token: "forged" })).status, 401);
    assert.equal((await call("POST", "/runs", { body: goodRun, headers: { Authorization: "Basic YWxpY2U6cHc=" } })).status, 401);
    assert.equal(fake.tables.runs.length, 0);
  });

  it("POST /runs validates the body", async () => {
    const bad = await call("POST", "/runs", { token: "alice-token", body: { base_url: "https://10.0.0.1", journeys: ["x"], modes: ["voiceover"] } });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body.errors.map((e) => e.field), ["base_url", "journeys", "modes"]);
    assert.equal((await call("POST", "/runs", { token: "alice-token", body: "{not json" })).status, 400);
    assert.equal((await call("POST", "/runs", { token: "alice-token", body: "x".repeat(20000) })).status, 413);
    const plain = await fetch(`${base}/runs`, { method: "POST", headers: { Authorization: "Bearer alice-token", "Content-Type": "text/plain" }, body: JSON.stringify(goodRun) });
    assert.equal(plain.status, 415);
    assert.equal(fake.tables.runs.length, 0);
  });

  it("POST /runs queues the run as the signed-in user, with their token", async () => {
    tokensSeen.length = 0;
    const { status, body, headers } = await call("POST", "/runs", { token: "alice-token", body: goodRun });
    assert.equal(status, 201, JSON.stringify(body));
    assert.deepEqual(tokensSeen, ["alice-token"]);
    const insert = fake.calls.findLast((c) => c.op === "insert" && c.table === "runs");
    assert.equal(insert.user, ALICE.id, "inserted through the user's client, so RLS applies");
    assert.deepEqual(insert.values, { user_id: ALICE.id, status: "queued", base_url: "https://preview.vercel.app/", journeys: [HOME], modes: ["walker"] });
    assert.equal(body.run.status, "queued");
    assert.equal(headers.get("location"), `/runs/${body.run.id}`);
  });

  it("POST /runs answers 429 when the database's per-user limit refuses the run", async () => {
    fake.failures.push({ op: "insert", table: "runs", error: { code: "53400", message: "You already have 3 runs waiting or running. Try again when one finishes." } });
    const { status, body } = await call("POST", "/runs", { token: "alice-token", body: goodRun });
    assert.equal(status, 429);
    assert.match(body.error, /3 runs/);
  });

  it("POST /runs answers 429 with the reason when the daily limit refuses the run (0002)", async () => {
    fake.failures.push({ op: "insert", table: "runs", error: { code: "53400", message: "You have started 10 runs today (UTC). Try again tomorrow." } });
    const { status, body } = await call("POST", "/runs", { token: "alice-token", body: goodRun });
    assert.equal(status, 429);
    assert.equal(body.error, "You have started 10 runs today (UTC). Try again tomorrow.");
  });

  it("GET /runs/:id returns your own run with its results, and nobody else's", async () => {
    const run = fake.tables.runs[0];
    fake.tables.run_results.push(
      { id: "r2", run_id: run.id, journey: HOME, mode: "walker", status: "pass" },
      { id: "r1", run_id: run.id, journey: BRAILLE, mode: "walker", status: "fail" }
    );
    const mine = await call("GET", `/runs/${run.id}`, { token: "alice-token" });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.run.id, run.id);
    assert.deepEqual(mine.body.run.run_results.map((r) => r.id), ["r2", "r1"], "sorted by journey path, then mode");
    assert.equal((await call("GET", `/runs/${run.id}`, { token: "bob-token" })).status, 404);
    assert.equal((await call("GET", `/runs/${run.id}`)).status, 401);
    assert.equal((await call("GET", "/runs/not-a-uuid", { token: "alice-token" })).status, 404);
  });

  it("answers CORS preflights only for allowed origins", async () => {
    const allowed = await fetch(`${base}/runs`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);
    assert.match(allowed.headers.get("access-control-allow-headers"), /Authorization/);
    const other = await fetch(`${base}/runs`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    assert.equal(other.status, 403);
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    const get = await call("GET", "/journeys", { headers: { Origin: ORIGIN } });
    assert.equal(get.headers.get("access-control-allow-origin"), ORIGIN);
    assert.equal((await call("GET", "/journeys", { headers: { Origin: "https://evil.example" } })).headers.get("access-control-allow-origin"), null);
  });

  it("answers 404 and 405", async () => {
    assert.equal((await call("GET", "/nope")).status, 404);
    const wrong = await call("DELETE", "/runs");
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
  });
});

describe('HTTP API with ALLOWED_TARGET_HOSTS="*"', () => {
  const ALICE = { id: "00000000-0000-4000-8000-00000000000a", email: "alice@example.org" };
  let fake;
  let server;
  let base;
  before(async () => {
    fake = fakeSupabase({ users: { "alice-token": ALICE } });
    const config = { allowedOrigins: [], targetRules: parseAllowedHosts("*") };
    const handler = createHandler({ config, catalog, auth: fake.auth, userClient: () => fake.asUser(ALICE.id), version: "test", log: { error() {} } });
    server = createServer(handler);
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const post = async (base_url) => {
    const response = await fetch(`${base}/runs`, { method: "POST", headers: { Authorization: "Bearer alice-token", "Content-Type": "application/json" }, body: JSON.stringify({ base_url, journeys: [HOME], modes: ["walker"] }) });
    return { status: response.status, body: await response.json() };
  };

  it("lists * as the allowed hosts", async () => {
    const body = await (await fetch(`${base}/journeys`)).json();
    assert.deepEqual(body.allowed_hosts, ["*"]);
  });

  it("queues a run on any public site, for a signed-in person", async () => {
    const { status, body } = await post("https://www.example.org/start");
    assert.equal(status, 201, JSON.stringify(body));
    assert.equal(body.run.base_url, "https://www.example.org/start");
  });

  for (const [url, why] of [
    ["http://127.0.0.1/", /private or reserved/],
    ["http://169.254.169.254/", /private or reserved/],
    ["https://[::ffff:10.0.0.1]/", /private or reserved/],
    ["https://localhost/", /local address/],
    ["https://intranet/", /not a full host name/],
    ["https://example.org:8443/", /ports 80 and 443 only/],
    ["https://me:pw@example.org/", /user name or password/],
  ]) {
    it(`refuses ${url} with 400, and queues nothing`, async () => {
      const before = fake.tables.runs.length;
      const { status, body } = await post(url);
      assert.equal(status, 400);
      assert.match(body.error, why);
      assert.equal(fake.tables.runs.length, before);
    });
  }
});
