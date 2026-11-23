#!/usr/bin/env node
// The hosted service: the HTTP API and the worker in one process. Settings come from the
// environment (see .env.example); docs/deploy.md explains the whole deployment.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { loadCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { timeoutFetch } from "./timeout-fetch.js";
import { createHandler } from "./http.js";
import { createWorker } from "./worker.js";
import { SCHEMA, workerDb } from "./worker-db.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// The browser must not run as this server's own user, or a page that breaks out of it could read
// WORKER_TOKEN from this process's environment. The Docker image starts the server as root
// and gives each run to the unprivileged user named by RUN_AS_UID.
const root = process.getuid?.() === 0;
if (root && !config.runAs) {
  console.error("This server is running as root, so RUN_AS_UID must name the unprivileged user that runs the browser (the Docker image sets it).");
  process.exit(1);
}
if (!root && config.runAs) {
  console.error("RUN_AS_UID is set, but only a server started as root can start runs as another user. Unset it, or start the server as root.");
  process.exit(1);
}
if (!config.runAs) console.warn("warning: the browser runs as this server's own user. That is fine for local testing, not for a public deployment (see docs/deploy.md).");

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const catalog = await loadCatalog();
const fetch = timeoutFetch(config.supabaseTimeoutMs);
// Every client uses the public anon key and the app's own schema. People's requests carry their
// own token, so row level security decides what they may do; the worker proves itself to the
// worker_* functions with WORKER_TOKEN. There is no service-role key.
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { schema: SCHEMA }, global: { fetch } };
const anon = createClient(config.supabaseUrl, config.supabaseAnonKey, clientOptions);
const userClient = (token) =>
  createClient(config.supabaseUrl, config.supabaseAnonKey, { ...clientOptions, global: { fetch, headers: { Authorization: `Bearer ${token}` } } });

const server = createServer(createHandler({ config, catalog, auth: anon.auth, userClient, version }));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(config.port, "0.0.0.0", () => {
  console.log(`screen-reader-journeys ${version} listening on port ${config.port}`);
  console.log(`journeys: ${catalog.length}; allowed sites: ${config.targetRules.map((r) => r.text).join(", ") || "none (ALLOWED_TARGET_HOSTS is empty)"}`);
  console.log(`allowed origins: ${config.allowedOrigins.join(", ") || "none (ALLOWED_ORIGINS is empty)"}`);
});

const worker = createWorker({ db: workerDb(anon, config.workerToken), catalog, config });
worker.start();

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping`);
  server.close();
  await worker.stop();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
