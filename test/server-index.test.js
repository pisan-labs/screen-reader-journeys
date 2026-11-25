// The service's entry point, started as a real process (so the coverage gate measures it too):
// it refuses a bad configuration or the wrong user, and otherwise listens, answers /health and
// stops on SIGTERM.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { WORKER_TOKEN } from "./helpers/fake-supabase.js";

const INDEX = fileURLToPath(new URL("../server/index.js", import.meta.url));
const root = process.getuid?.() === 0;

/** A port nothing listens on now. */
const freePort = () =>
  new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = /** @type {import("node:net").AddressInfo} */ (probe.address());
      probe.close(() => resolve(port));
    });
  });

/**
 * Start server/index.js with only `env` (and PATH, and the coverage folder when measuring). With
 * `as`, as that user.
 */
function start(env, as = null) {
  const inherited = Object.fromEntries(["PATH", "NODE_V8_COVERAGE"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
  const child = spawn(process.execPath, [INDEX], { env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "pipe"], ...(as ?? {}) });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal, output })));
  return { child, exited, output: () => output };
}

async function until(check, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A configuration that loads: Supabase points at a closed port, so the worker only logs. */
async function goodEnv(extra = {}) {
  return {
    SUPABASE_URL: `http://127.0.0.1:${await freePort()}`,
    SUPABASE_ANON_KEY: "anon",
    WORKER_TOKEN,
    PORT: String(await freePort()),
    POLL_INTERVAL_SECONDS: "60",
    ...extra,
  };
}

// Started by root, the server needs RUN_AS_UID, and then refuses a host whose fs.suid_dumpable is
// not 0 or 2 (worker.js, start). So that the tests below do not depend on the host, root starts
// them as an ordinary user (nobody) instead, which needs neither.
const ordinary = root ? { uid: 65534, gid: 65534 } : null;

/**
 * Whether nobody can read this checkout, which those tests need. One under /root (0700) is out of
 * its reach; CI runs them as an ordinary user, so it is not affected (R5.2). A server that cannot
 * write root's coverage folder only goes unmeasured.
 */
const asNobody = (code) => spawnSync(process.execPath, ["-e", code], { ...ordinary, stdio: "ignore", env: {} }).status === 0;
const unreachable = root && !asNobody(`require("fs").accessSync(${JSON.stringify(INDEX)}, require("fs").constants.R_OK)`) && "nobody cannot read this checkout (one under /root, say); CI runs these as an ordinary user";

describe("server/index.js", () => {
  it("refuses to start with a bad configuration, listing every problem", async () => {
    const { code, output } = await start({}).exited;
    assert.equal(code, 1);
    assert.match(output, /Configuration problems/);
    assert.match(output, /SUPABASE_URL is not set/);
    assert.match(output, /WORKER_TOKEN is not set/);
  });

  it("refuses the wrong user: root without RUN_AS_UID, or RUN_AS_UID without root", async () => {
    const env = await goodEnv(root ? {} : { RUN_AS_UID: "10001" });
    const { code, output } = await start(env).exited;
    assert.equal(code, 1);
    assert.match(output, root ? /RUN_AS_UID must name the unprivileged user/ : /only a server started as root/);
  });

  for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT"])) {
    it(`listens, answers /health, and stops on ${signal}`, { skip: unreachable }, async () => {
      const env = await goodEnv();
      const server = start(env, ordinary);
      try {
        await until(() => server.output().includes("listening on port"));
        const response = await fetch(`http://127.0.0.1:${env.PORT}/health`);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).status, "ok");
        assert.match(server.output(), /the browser runs as this server's own user/);
      } finally {
        server.child.kill(signal);
      }
      const { code, output } = await server.exited;
      assert.equal(code, 0, output);
      assert.match(output, new RegExp(`${signal}: stopping`));
    });
  }
});
