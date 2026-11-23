// Build the dashboard into dist/: bundle src/app.js (with supabase-js), copy the page and its
// styles, write config.js from the environment, and write Netlify's _headers with a
// Content-Security-Policy that allows exactly this deployment's Supabase project and API.
//
//   VITE_SUPABASE_URL       https://<project>.supabase.co
//   VITE_SUPABASE_ANON_KEY  the project's anon (publishable) key, which is public by design
//   VITE_API_URL            the Render service, e.g. https://screen-reader-journeys.onrender.com
//
// (The names follow Vite's convention for values that end up in the browser.) On Netlify all
// three are required; locally, missing values leave the dashboard showing how to configure it.
//
//   node build.mjs           build once
//   node build.mjs --serve   build, rebuild when app.js changes, and serve on http://127.0.0.1:5173
//
// WEB_OUT_DIR builds somewhere other than dist/ (the tests use it).

import { context } from "esbuild";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = (path) => fileURLToPath(new URL(path, import.meta.url));
const dist = process.env.WEB_OUT_DIR ? `${resolve(process.env.WEB_OUT_DIR)}/` : dir("dist/");
const serve = process.argv.includes("--serve");
const required = process.env.NETLIFY === "true";

function url(name) {
  const value = (process.env[name] ?? "").trim().replace(/\/+$/, "");
  if (!value) {
    if (required) throw new Error(`${name} is not set. Set it in the Netlify site's environment variables.`);
    return "";
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !local) throw new Error(`${name} must start with https://`);
  return value;
}

/** Refuse a service role or secret key: it would give every visitor full access to the database. */
function publicKey(name) {
  const key = (process.env[name] ?? "").trim();
  if (!key && required) throw new Error(`${name} is not set. Set it in the Netlify site's environment variables.`);
  let role = null;
  try {
    role = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString()).role ?? null;
  } catch {
    // Not a JWT: the newer sb_publishable_ / sb_secret_ keys.
  }
  if (key.startsWith("sb_secret_") || role === "service_role") {
    throw new Error(`${name} is a secret (service role) key. Use the project's anon or publishable key; the secret key belongs only on the Render service.`);
  }
  return key;
}

const config = { supabaseUrl: url("VITE_SUPABASE_URL"), supabaseAnonKey: publicKey("VITE_SUPABASE_ANON_KEY"), apiUrl: url("VITE_API_URL") };

const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  `connect-src ${["'self'", config.supabaseUrl, config.apiUrl].filter(Boolean).join(" ")}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

async function copyStatic() {
  await copyFile(dir("src/index.html"), `${dist}index.html`);
  await copyFile(dir("src/styles.css"), `${dist}styles.css`);
  await writeFile(`${dist}config.js`, `window.SRJ_CONFIG = ${JSON.stringify(config)};\n`);
  await writeFile(`${dist}_headers`, `/*\n  Content-Security-Policy: ${csp}\n`);
}

// Start dist/ afresh; a WEB_OUT_DIR is only written into, never emptied.
if (!process.env.WEB_OUT_DIR) await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const ctx = await context({
  entryPoints: [dir("src/app.js")],
  outfile: `${dist}app.js`,
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: !serve,
  sourcemap: serve,
  logLevel: "info",
  plugins: [{ name: "static", setup: (build) => build.onEnd(copyStatic) }],
});
if (serve) {
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: dist, host: "127.0.0.1", port: 5173 });
  console.log(`Dashboard on http://127.0.0.1:${port}${config.supabaseUrl ? "" : " (not configured: set VITE_* in ../.env)"}`);
} else {
  await ctx.rebuild();
  await ctx.dispose();
  console.log(`Built dist/ for ${config.apiUrl || "(no VITE_API_URL)"}`);
}
