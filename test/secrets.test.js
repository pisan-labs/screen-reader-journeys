// The worker's token lives only in the Render service's environment, and its SHA-256 only in the
// database, pinned by gated ops SQL (docs/deploy.md, "The worker token"). Neither may be in a
// committed file.
//
// With the real token in the environment (WORKER_TOKEN=... node --test test/secrets.test.js, as
// PManager can run it before a release), every tracked file is searched for the token and its
// hash. Without it, the files that would hold either are checked for placeholders only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "../server/catalog.js";

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO_ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
const read = (file) => {
  try {
    return readFileSync(join(REPO_ROOT, file), "utf8");
  } catch {
    return ""; // deleted in the working tree
  }
};

describe("the worker token and its hash are never committed", () => {
  const token = process.env.WORKER_TOKEN?.trim();

  it("no tracked file holds the token or its SHA-256", { skip: !token && "WORKER_TOKEN is not set here" }, () => {
    const sha256 = createHash("sha256").update(token).digest("hex");
    const found = tracked.filter((file) => {
      const text = read(file);
      return text.includes(token) || text.toLowerCase().includes(sha256);
    });
    assert.deepEqual(found, []);
  });

  it("the ops file holds only its placeholder", () => {
    const sql = read("supabase/ops/worker-token.sql");
    assert.match(sql, /v_sha256 text := '0{64}';/);
    assert.deepEqual(sql.match(/[0-9a-f]{64}/gi).filter((hex) => !/^0+$/.test(hex)), []);
  });

  it("no migration pins a hash", () => {
    for (const file of tracked.filter((f) => f.startsWith("supabase/migrations/"))) {
      const sql = read(file);
      assert.doesNotMatch(sql, /insert\s+into\s+app_screen_reader_journeys\.worker_config/i, file);
      assert.doesNotMatch(sql, /[0-9a-f]{64}/i, file);
    }
  });

  it("the settings files name WORKER_TOKEN without a value", () => {
    assert.match(read(".env.example"), /^WORKER_TOKEN=$/m);
    const render = read("render.yaml");
    assert.match(render, /- key: WORKER_TOKEN\n\s+sync: false/);
    assert.doesNotMatch(render, /- key: WORKER_TOKEN\n\s+value:/);
  });

  it("outside the tests, nothing assigns WORKER_TOKEN a value", () => {
    const assigned = tracked
      .filter((file) => !file.startsWith("test/") && !file.endsWith("package-lock.json"))
      .filter((file) => /WORKER_TOKEN\s*[=:]\s*["']?[A-Za-z0-9+/_-]{16,}/.test(read(file)));
    assert.deepEqual(assigned, []);
  });
});
