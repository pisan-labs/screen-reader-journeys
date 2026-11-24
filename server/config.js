// The server's settings, from environment variables. See .env.example and docs/deploy.md.

import { parseAllowedHosts } from "./hosts.js";

const blank = (value) => value === undefined || value.trim() === "";

function parseOrigins(value = "") {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => {
      let url;
      try {
        url = new URL(text);
      } catch {
        throw new Error(`ALLOWED_ORIGINS: "${text}" is not a URL`);
      }
      if (url.origin !== text.replace(/\/$/, "")) throw new Error(`ALLOWED_ORIGINS: "${text}" must be an origin such as https://example.netlify.app, without a path`);
      return url.origin;
    });
}

function positiveNumber(env, name, fallback) {
  if (blank(env[name])) return fallback;
  const value = Number(env[name]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

/**
 * RUN_AS_UID (and RUN_AS_GID, which defaults to the same number): the unprivileged user that runs
 * each run's browser. Null when unset.
 */
function runAsUser(env) {
  if (!env.RUN_AS_UID) return null;
  const id = (name, value) => {
    if (!/^\d+$/.test(value) || Number(value) === 0) throw new Error(`${name} must be the number of a user other than root`);
    return Number(value);
  };
  const uid = id("RUN_AS_UID", env.RUN_AS_UID);
  return { uid, gid: id("RUN_AS_GID", env.RUN_AS_GID ?? env.RUN_AS_UID) };
}

/**
 * @typedef {object} Config
 * @property {string} supabaseUrl
 * @property {string} supabaseAnonKey
 * @property {string} workerToken
 * @property {string[]} allowedOrigins
 * @property {string} allowedTargetHosts
 * @property {any[]} targetRules
 * @property {number} port
 * @property {number} runTimeoutMs
 * @property {number} pollIntervalMs
 * @property {boolean} chromiumSandbox
 * @property {{ uid: number, gid: number } | null} runAs
 * @property {number} supabaseTimeoutMs
 */

/**
 * Read and check the settings. Throws with every problem at once, so a misconfigured deploy
 * fails at start-up.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Readonly<Config>}
 */
export function loadConfig(env = process.env) {
  const problems = [];
  const need = (name) => {
    if (blank(env[name])) problems.push(`${name} is not set`);
    return env[name]?.trim();
  };
  /** @type {Config} */
  const config = /** @type {any} */ ({
    supabaseUrl: need("SUPABASE_URL"),
    supabaseAnonKey: need("SUPABASE_ANON_KEY"),
    // The worker's proof to the worker_* functions; the database keeps only its SHA-256.
    workerToken: need("WORKER_TOKEN"),
  });
  // Printable ASCII only, so the server and the database count it the same way, and stray
  // whitespace or a pasted newline is caught here rather than as "Bad worker token." later.
  if (config.workerToken && !/^[\x21-\x7e]{32,200}$/.test(config.workerToken)) {
    problems.push("WORKER_TOKEN must be 32 to 200 printable ASCII characters, without spaces (make one with: openssl rand -base64 32)");
  }
  // HintWise apps never hold the service-role key; refuse to start with one in reach.
  if (!blank(env.SUPABASE_SERVICE_ROLE_KEY)) problems.push("SUPABASE_SERVICE_ROLE_KEY is set: remove it. This server needs only the anon key and WORKER_TOKEN");
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      problems.push(error.message);
      return undefined;
    }
  };
  config.allowedOrigins = attempt(() => parseOrigins(env.ALLOWED_ORIGINS)) ?? [];
  config.allowedTargetHosts = env.ALLOWED_TARGET_HOSTS ?? "";
  config.targetRules = attempt(() => parseAllowedHosts(config.allowedTargetHosts)) ?? [];
  config.port = attempt(() => positiveNumber(env, "PORT", 8080));
  config.runTimeoutMs = attempt(() => positiveNumber(env, "RUN_TIMEOUT_SECONDS", 900)) * 1000;
  config.pollIntervalMs = attempt(() => positiveNumber(env, "POLL_INTERVAL_SECONDS", 5)) * 1000;
  config.chromiumSandbox = /^(1|true|yes)$/i.test(env.CHROMIUM_SANDBOX ?? "");
  config.runAs = attempt(() => runAsUser(env));
  config.supabaseTimeoutMs = attempt(() => positiveNumber(env, "SUPABASE_TIMEOUT_SECONDS", 30)) * 1000;
  if (config.supabaseUrl && !/^https?:\/\//.test(config.supabaseUrl)) problems.push("SUPABASE_URL must start with https://");
  if (problems.length) throw new Error(`Configuration problems:\n- ${problems.join("\n- ")}`);
  return Object.freeze(config);
}
