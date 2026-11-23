#!/usr/bin/env node
// The hosted service: the HTTP API and the worker in one process. Settings come from the
// environment (see .env.example); docs/deploy.md explains the whole deployment.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { loadCatalog } from "./catalog.js";
import { loadConfig } from "./config.js";
import { createHandler } from "./http.js";
import { createWorker } from "./worker.js";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const catalog = await loadCatalog();
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const anon = createClient(config.supabaseUrl, config.supabaseAnonKey, clientOptions);
const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, clientOptions);
const userClient = (token) =>
  createClient(config.supabaseUrl, config.supabaseAnonKey, { ...clientOptions, global: { headers: { Authorization: `Bearer ${token}` } } });

const server = createServer(createHandler({ config, catalog, auth: anon.auth, userClient, version }));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
server.listen(config.port, "0.0.0.0", () => {
  console.log(`screen-reader-journeys ${version} listening on port ${config.port}`);
  console.log(`journeys: ${catalog.length}; allowed sites: ${config.targetRules.map((r) => r.text).join(", ") || "none (ALLOWED_TARGET_HOSTS is empty)"}`);
  console.log(`allowed origins: ${config.allowedOrigins.join(", ") || "none (ALLOWED_ORIGINS is empty)"}`);
});

const worker = createWorker({ admin, catalog, config });
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
