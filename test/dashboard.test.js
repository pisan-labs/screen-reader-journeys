// The dashboard (web/), checked with this tool itself: build it with Vite (web/ must have its
// node_modules: npm ci --prefix web), serve it, answer Supabase, the platform's sign-in and the
// API inside the browser, and walk it by keyboard. Also loads it under its own
// Content-Security-Policy, which runJourney bypasses.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { runJourney } from "../src/journey.js";

// As in production: the shared HintWise project, which also takes the analytics events.
const SUPABASE = "https://auth.hintwise.org";
const API = "https://api.srj.test";
const USER = { id: "00000000-0000-4000-8000-00000000000a", aud: "authenticated", role: "authenticated", email: "reviewer@example.org" };
const RUN_ID = "3f2a1c9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b";
const HOME = "targets/generic/home-tab-order.journey.js";
const CATALOG = {
  journeys: [
    { path: HOME, name: "Home page: Tab order", description: "Every Tab stop on the site's home page." },
    { path: "targets/stem-accessibility/journeys/braille-download.journey.js", name: "Shared STEM image: download the braille file", description: "" },
  ],
  modes: ["walker", "virtual"],
  allowed_hosts: ["*.vercel.app"],
};

let out;
let site;
let csp;

before(async () => {
  out = await mkdtemp(join(tmpdir(), "srj-web-"));
  const web = fileURLToPath(new URL("../web/", import.meta.url));
  await promisify(execFile)(process.execPath, [join(web, "node_modules/vite/bin/vite.js"), "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], {
    cwd: web,
    env: { ...process.env, VITE_SUPABASE_URL: SUPABASE, VITE_SUPABASE_ANON_KEY: "anon-key", VITE_API_URL: API },
  });
  csp = /Content-Security-Policy: (.*)/.exec(await readFile(join(out, "_headers"), "utf8"))[1];
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".txt": "text/plain; charset=utf-8" };
  const server = createServer(async (req, res) => {
    const name = new URL(req.url, "http://x").pathname.slice(1) || "index.html";
    if (!/^(assets\/)?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.(html|js|css|txt)$/.test(name)) return res.writeHead(404).end();
    try {
      res.writeHead(200, { "Content-Type": types[extname(name)], "Content-Security-Policy": csp }).end(await readFile(join(out, name)));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  site = { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
});
after(async () => {
  site?.close();
  await rm(out, { recursive: true, force: true });
});

/** Answer Supabase and the API inside the browser, as targets/stem-accessibility/mock.js does for its backend. */
async function fakeBackend(page, { signedIn, posted = [], reportReads = [] }) {
  if (signedIn) {
    const session = { access_token: "header.payload.signature", refresh_token: "refresh", token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER };
    await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ["sb-auth-auth-token", JSON.stringify(session)]);
  }
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
  let runReads = 0;
  const run = () => ({
    id: RUN_ID,
    base_url: "https://preview.vercel.app/",
    journeys: [HOME],
    modes: ["walker"],
    status: runReads > 1 ? "done" : "running",
    created_at: "2026-11-23T10:00:00Z",
    started_at: "2026-11-23T10:00:05Z",
    finished_at: runReads > 1 ? "2026-11-23T10:00:40Z" : null,
    error: null,
    summary: runReads > 1 ? { results: 1, passed: 1, failed: 0, errored: 0, errors: 2, warnings: 1, files: ["home-page-tab-order.walker.md", "summary.md"], blocked_requests: [], timed_out: false } : null,
    run_results: runReads > 1 ? [{ id: "r1", run_id: RUN_ID, journey: HOME, mode: "walker", status: "pass", checks_passed: 0, checks_total: 0, errors: 2, warnings: 1, report_path: "home-page-tab-order.walker.md" }] : [],
  });
  await page.route(`${SUPABASE}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const { pathname } = new URL(request.url());
    // The platform's sign-in function (src/lib/auth.ts sendMagicLink) and the analytics events.
    if (pathname === "/functions/v1/sign-in-link") return json(route, { status: "sent", withCode: true });
    if (pathname === "/functions/v1/app-events") return route.fulfill({ status: 204, headers: cors });
    if (pathname === "/rest/v1/rpc/ensure_profile") return json(route, null);
    if (pathname === "/auth/v1/user") return json(route, USER);
    if (pathname === "/auth/v1/logout") return route.fulfill({ status: 204, headers: cors });
    // The app's own schema, as supabase-js asks for it.
    if (pathname.startsWith("/rest/v1/") && request.headers()["accept-profile"] !== "app_screen_reader_journeys") return json(route, { message: "wrong schema" }, 406);
    if (pathname === "/rest/v1/runs") return json(route, posted.length ? [{ id: RUN_ID, base_url: "https://preview.vercel.app/", status: "queued", created_at: "2026-11-23T10:00:00Z", summary: null }] : []);
    if (pathname === "/rest/v1/run_reports") {
      const query = new URL(request.url()).searchParams;
      const paths = /^in\.\((.*)\)$/.exec(query.get("path") ?? "")?.[1].split(",").map((p) => p.replace(/^"|"$/g, "")) ?? [];
      const withBody = /body/.test(query.get("select") ?? "");
      reportReads.push(query.get("select"));
      return json(route, paths.map((path) => (withBody ? { path, body: `# ${path}` } : { path, content_type: "text/markdown; charset=utf-8" })));
    }
    return json(route, { message: `unexpected ${pathname}` }, 404);
  });
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const { pathname } = new URL(request.url());
    if (pathname === "/journeys") return json(route, CATALOG);
    if (pathname === "/runs" && request.method() === "POST") {
      posted.push(JSON.parse(request.postData()));
      return json(route, { run: { id: RUN_ID, status: "queued" } }, 201);
    }
    if (pathname === `/runs/${RUN_ID}`) {
      runReads += 1;
      return json(route, { run: run() });
    }
    return json(route, { error: "Not found." }, 404);
  });
}

const signIn = {
  name: "Dashboard: sign in with an emailed code",
  start: "/index.html",
  ready: "button.hw-signin-google",
  setup: (page) => fakeBackend(page, { signedIn: false }),
  async run(sr) {
    await sr.tabTo({ role: "link", name: "Skip to main content" }, { max: 1 });
    await sr.tabTo({ role: "button", name: "Sign in with Google" });
    await sr.tabTo({ role: "button", name: "Email code" });
    await sr.activate();
    // The panel opens with the focus in its email box.
    await sr.expectFocus({ role: "textbox", name: "Email for a sign-in code" });
    await sr.page.keyboard.type("reviewer@example.org");
    await sr.tabTo({ role: "button", name: "Email me a sign-in code" });
    await sr.activate();
    await sr.expectAnnouncement(/We sent a 6-digit code to reviewer@example\.org/);
    // The focus moves to the code box, which names what was sent.
    await sr.expectFocus({ role: "textbox", name: /Sign-in code/ });
    await sr.tabTo({ role: "button", name: "Sign in" }, { max: 1 });
  },
};

const posted = [];
const reportReads = [];
const startRun = {
  name: "Dashboard: start a run and read its results",
  start: "/index.html",
  ready: "#base-url",
  setup: (page) => fakeBackend(page, { signedIn: true, posted, reportReads }),
  async run(sr) {
    await sr.walkTabOrder();
    await sr.tabTo({ role: "button", name: "Start run" });
    await sr.activate();
    await sr.expectAnnouncement(/There are 2 problems.*Enter the site's address.*Choose at least one journey/);
    await sr.expectFocus({ role: "textbox", name: "Site address" });
    await sr.page.keyboard.type("https://preview.vercel.app");
    await sr.tabTo({ role: "checkbox", name: "Home page: Tab order" });
    await sr.activate();
    await sr.tabTo({ role: "button", name: "Start run" });
    await sr.activate();
    await sr.expectAnnouncement("Run queued.");
    await sr.expectFocus({ role: "heading", name: /^Run/ });
    await sr.expectAnnouncement(/The run finished: 1 passed, 0 failed, 0 errors\./, { within: 12000 });
    await sr.tabTo({ role: "button", name: "Download the report for Home page: Tab order, Keyboard walker" });
    await sr.activate({ expectDownload: "home-page-tab-order.walker.md" });
    await sr.expectAnnouncement("Downloaded home-page-tab-order.walker.md.");
    await sr.walkTabOrder();
  },
};

function assertAccessible(result) {
  assert.equal(result.status, "pass", `${result.error ?? ""} ${JSON.stringify(result.expectations.filter((e) => !e.ok))}`);
  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.findings, [], "no automatic findings: every Tab stop has a role, a name and a focus indicator");
}

describe("dashboard accessibility", () => {
  for (const mode of ["walker", "virtual"]) {
    it(`signs in with an emailed code by keyboard, hearing what was sent (${mode})`, async () => {
      assertAccessible(await runJourney({ ...signIn, file: "test/dashboard.test.js" }, { mode, baseUrl: site.url }));
    });
  }

  it("starts a run and reads its results by keyboard (walker)", async () => {
    const result = await runJourney({ ...startRun, file: "test/dashboard.test.js" }, { mode: "walker", baseUrl: site.url });
    assertAccessible(result);
    assert.deepEqual(posted, [{ base_url: "https://preview.vercel.app", journeys: [HOME], modes: ["walker", "virtual"] }]);
    assert.deepEqual(reportReads, ["path,content_type", "path,body"], "names to draw the page, then one body on request");
    const heard = result.steps.flatMap((s) => s.spoken).join(" / ");
    assert.match(heard, /Skip to main content, link/);
    assert.match(heard, /reviewer@example\.org/);
    assert.match(heard, /Site address, textbox/);
  });
});

describe("dashboard under its Content-Security-Policy", () => {
  it("allows exactly the configured Supabase project and API, and the sign-in check", () => {
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com(;|$)/);
    assert.match(csp, new RegExp(`connect-src 'self' ${SUPABASE} ${API}(;|$)`));
    assert.match(csp, /frame-ancestors 'none'/);
  });

  it("loads and talks to Supabase and the API with no violations", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const violations = [];
      page.on("console", (message) => /Content Security Policy|Refused to/i.test(message.text()) && violations.push(message.text()));
      await fakeBackend(page, { signedIn: true, posted: [] });
      await page.goto(`${site.url}/index.html`);
      await page.getByRole("checkbox", { name: "Home page: Tab order" }).waitFor();
      await page.getByRole("heading", { name: "Runs", level: 1 }).waitFor();
      await page.getByText("You have not started any runs yet.").waitFor();
      assert.deepEqual(violations, []);
    } finally {
      await browser.close();
    }
  });
});

describe("dashboard on a phone", () => {
  it("does not scroll sideways at 375 px, signed out, on the runs page or on a run", async () => {
    const browser = await chromium.launch();
    try {
      const widths = {};
      for (const [name, signedIn, hash] of [["signed out", false, ""], ["runs", true, ""], ["run", true, `#/runs/${RUN_ID}`]]) {
        const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
        await fakeBackend(page, { signedIn, posted: [] });
        await page.goto(`${site.url}/index.html${hash}`);
        await page.locator(hash ? "h1:has-text('Run on')" : signedIn ? "#base-url" : "button.hw-signin-google").waitFor();
        widths[name] = await page.evaluate(() => document.documentElement.scrollWidth);
        await page.close();
      }
      assert.deepEqual(widths, { "signed out": 375, runs: 375, run: 375 });
    } finally {
      await browser.close();
    }
  });
});
