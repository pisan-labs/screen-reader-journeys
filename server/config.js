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

/** Read and check the settings. Throws with every problem at once, so a misconfigured deploy fails at start-up. */
export function loadConfig(env = process.env) {
  const problems = [];
  const need = (name) => {
    if (blank(env[name])) problems.push(`${name} is not set`);
    return env[name]?.trim();
  };
  const config = {
    supabaseUrl: need("SUPABASE_URL"),
    supabaseAnonKey: need("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: need("SUPABASE_SERVICE_ROLE_KEY"),
  };
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
  if (config.supabaseUrl && !/^https?:\/\//.test(config.supabaseUrl)) problems.push("SUPABASE_URL must start with https://");
  if (problems.length) throw new Error(`Configuration problems:\n- ${problems.join("\n- ")}`);
  return Object.freeze(config);
}
