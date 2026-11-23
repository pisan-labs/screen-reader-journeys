// The dashboard: sign in with a Supabase magic link, start runs through the API, follow a run
// and download its reports through signed Storage URLs.
//
// Accessibility: every view is plain HTML (headings, labelled fields, fieldsets, tables, links
// and buttons); a page change moves focus to its heading; progress goes to the role="status"
// line and errors to the role="alert" box, which stay in the page; status is always in words.

import { createClient } from "@supabase/supabase-js";

const config = window.SRJ_CONFIG ?? {};
const SITE = "Screen reader journeys";
const STATUS = { queued: ["Waiting", "busy"], running: ["Running", "busy"], done: ["Finished", "ok"], failed: ["Failed", "bad"] };
const RESULT = { pass: ["Passed", "ok"], fail: ["Failed", "bad"], error: ["Error", "bad"] };
const MODES = {
  walker: ["Keyboard walker", "Each Tab stop's role, name and states, from Chromium's accessibility tree, and live-region announcements."],
  virtual: ["Emulated screen reader", "Guidepup's Virtual Screen Reader: its speech for each step, and line-by-line reading."],
};
const POLL_MS = 4000;
const LINK_SECONDS = 3600;

const $ = (id) => document.getElementById(id);
const view = $("view");
const account = $("account");
const alertBox = $("alert");
const statusLine = $("status");

/** Build an element: h("a", { href: "#/" }, "text", child…). Text is always set as text, never as HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const hidden = (text) => h("span", { class: "visually-hidden" }, text);

/**
 * Wrap a table so it scrolls sideways on narrow screens. Only while it overflows is the wrapper a
 * labelled region in the Tab order, so keyboard users can scroll it; otherwise it is invisible
 * to assistive technology and adds no Tab stop.
 */
function scrollable(table, label) {
  const wrap = h("div", { class: "table-scroll" }, table);
  const update = () => {
    const overflows = wrap.scrollWidth > wrap.clientWidth + 1;
    for (const [name, value] of [["role", "region"], ["tabindex", "0"], ["aria-label", label]]) {
      if (overflows) wrap.setAttribute(name, value);
      else wrap.removeAttribute(name);
    }
  };
  new ResizeObserver(update).observe(wrap);
  return wrap;
}
const badge = ([label, tone]) => h("span", { class: `badge ${tone}` }, label);
const when = (iso) => (iso ? h("time", { datetime: iso }, new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })) : "—");
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Announcements -------------------------------------------------------------------------------

let statusTimer;
/** Say something in the status line. Cleared first, so the same words are announced again. */
function announce(text) {
  clearTimeout(statusTimer);
  statusLine.textContent = "";
  statusTimer = setTimeout(() => (statusLine.textContent = text), 50);
}

/** Show an error in the alert box: a sentence, or a heading and a list of problems. */
function showError(message, problems = []) {
  alertBox.replaceChildren();
  if (problems.length) alertBox.append(h("h2", {}, message), h("ul", {}, problems.map((p) => h("li", {}, p))));
  else alertBox.append(h("p", {}, message));
}

const clearError = () => alertBox.replaceChildren();

/** Replace the view, set the page title, and (after a user's action) move focus to the new heading. */
function show(title, nodes, { focus = true } = {}) {
  view.replaceChildren(...nodes);
  document.title = `${title} – ${SITE}`;
  if (focus) view.querySelector("h1")?.focus();
}

// Supabase and the API ------------------------------------------------------------------------

const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey && config.apiUrl);
const supabase = configured
  ? createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { flowType: "pkce", persistSession: true, detectSessionInUrl: true } })
  : null;

class ApiError extends Error {
  constructor(status, message, errors = []) {
    super(message);
    Object.assign(this, { status, errors });
  }
}

async function api(path, { method = "GET", body } = {}) {
  const { data } = await supabase.auth.getSession();
  const headers = { Accept: "application/json" };
  if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(`${config.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, "Could not reach the server. If it has been idle it may be starting up, which can take a minute; try again.");
  }
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && data.session) {
    await supabase.auth.signOut({ scope: "local" });
    throw new ApiError(401, "Your session has ended. Sign in again.");
  }
  if (!response.ok) throw new ApiError(response.status, payload.error ?? `The server answered ${response.status}.`, payload.errors ?? []);
  return payload;
}

let catalog = null;
async function loadCatalog() {
  catalog ??= api("/journeys").catch((error) => {
    catalog = null;
    throw error;
  });
  return catalog;
}
const journeyName = (list, path) => list?.journeys.find((j) => j.path === path)?.name ?? path;

// Sign in -------------------------------------------------------------------------------------

function renderSignIn({ focus = true } = {}) {
  const email = h("input", { id: "email", name: "email", type: "email", autocomplete: "email", required: true, "aria-describedby": "email-hint email-error" });
  const error = h("p", { id: "email-error", class: "field-error" });
  const submit = h("button", { type: "submit" }, "Send sign-in link");
  const form = h(
    "form",
    { novalidate: true, "aria-labelledby": "sign-in-heading" },
    h("div", { class: "field" }, h("label", { for: "email" }, "Email address"), h("p", { id: "email-hint", class: "hint" }, "We email you a link. Open it in this browser to sign in."), email, error),
    h("div", {}, submit)
  );
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearError();
    const address = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      error.textContent = "Enter an email address, like name@example.org.";
      email.setAttribute("aria-invalid", "true");
      showError("Enter an email address, like name@example.org.");
      email.focus();
      return;
    }
    error.textContent = "";
    email.removeAttribute("aria-invalid");
    submit.setAttribute("aria-disabled", "true");
    announce("Sending a sign-in link…");
    const { error: failure } = await supabase.auth.signInWithOtp({ email: address, options: { emailRedirectTo: `${location.origin}${location.pathname}` } });
    submit.removeAttribute("aria-disabled");
    if (failure) {
      announce("");
      showError(/signups? not allowed/i.test(failure.message) ? "This address has no account here. Ask the person who runs this service for an invitation." : `The sign-in link could not be sent: ${failure.message}`);
      return;
    }
    announce(`Check your email: we sent a sign-in link to ${address}. Open it in this browser.`);
  });
  show("Sign in", [h("h1", { id: "sign-in-heading", tabindex: "-1" }, "Sign in"), h("p", {}, "Sign in to start runs and read their reports."), form], { focus });
}

// Runs list and the new-run form -------------------------------------------------------------

function runRow(run) {
  const [passed, failed, errored] = [run.summary?.passed ?? 0, run.summary?.failed ?? 0, run.summary?.errored ?? 0];
  const results = run.summary ? [passed && `${passed} passed`, failed && `${failed} failed`, errored && plural(errored, "error")].filter(Boolean).join(", ") || "No results" : "—";
  return h(
    "tr",
    {},
    h("th", { scope: "row" }, h("a", { href: `#/runs/${run.id}` }, when(run.created_at), hidden(`, ${hostOf(run.base_url)}`))),
    h("td", { class: "url" }, hostOf(run.base_url)),
    h("td", {}, badge(STATUS[run.status] ?? [run.status, "busy"])),
    h("td", {}, results)
  );
}

async function renderRunsTable(container) {
  const { data, error } = await supabase.from("runs").select("id, base_url, status, created_at, summary").order("created_at", { ascending: false }).limit(50);
  if (error) {
    container.replaceChildren(h("p", {}, "Your runs could not be loaded."));
    showError(`Your runs could not be loaded: ${error.message}`);
    return;
  }
  if (!data.length) {
    container.replaceChildren(h("p", {}, "You have not started any runs yet."));
    return;
  }
  const caption = `Your ${data.length === 50 ? "50 latest" : plural(data.length, "run")}, newest first`;
  container.replaceChildren(
    scrollable(
      h(
        "table",
        {},
        h("caption", {}, caption),
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Started"), h("th", { scope: "col" }, "Site"), h("th", { scope: "col" }, "Status"), h("th", { scope: "col" }, "Results"))),
        h("tbody", {}, data.map(runRow))
      ),
      caption
    )
  );
}

function newRunForm(list) {
  const remembered = (() => {
    try {
      return localStorage.getItem("srj:base_url") ?? "";
    } catch {
      return "";
    }
  })();
  const baseUrl = h("input", { id: "base-url", name: "base_url", type: "url", inputmode: "url", autocomplete: "url", spellcheck: "false", required: true, value: remembered, "aria-describedby": "base-url-hint base-url-error" });
  const errors = {
    base_url: h("p", { id: "base-url-error", class: "field-error" }),
    journeys: h("p", { id: "journeys-error", class: "field-error" }),
    modes: h("p", { id: "modes-error", class: "field-error" }),
  };
  const allowed = list.allowed_hosts.length ? `This server may test ${list.allowed_hosts.join(", ")}.` : "This server has no allowed sites yet, so runs will be refused.";
  const journeyBoxes = list.journeys.map((journey, i) =>
    h(
      "div",
      { class: "choice" },
      h("input", { type: "checkbox", id: `journey-${i}`, name: "journeys", value: journey.path, "aria-describedby": journey.description ? `journey-${i}-hint` : null }),
      h("label", { for: `journey-${i}` }, journey.name),
      journey.description ? h("p", { id: `journey-${i}-hint`, class: "hint" }, journey.description) : null
    )
  );
  const modeBoxes = list.modes.map((mode) =>
    h(
      "div",
      { class: "choice" },
      h("input", { type: "checkbox", id: `mode-${mode}`, name: "modes", value: mode, checked: true, "aria-describedby": `mode-${mode}-hint` }),
      h("label", { for: `mode-${mode}` }, MODES[mode]?.[0] ?? mode),
      h("p", { id: `mode-${mode}-hint`, class: "hint" }, MODES[mode]?.[1] ?? "")
    )
  );
  const submit = h("button", { type: "submit" }, "Start run");
  const form = h(
    "form",
    { novalidate: true, "aria-labelledby": "new-run-heading" },
    h("div", { class: "field" }, h("label", { for: "base-url" }, "Site address"), h("p", { id: "base-url-hint", class: "hint" }, `Where the journeys start, for example a pull request's preview. ${allowed}`), baseUrl, errors.base_url),
    h("fieldset", { "aria-describedby": "journeys-error" }, h("legend", {}, "Journeys"), journeyBoxes, errors.journeys),
    h("fieldset", { "aria-describedby": "modes-error" }, h("legend", {}, "Modes"), modeBoxes, errors.modes),
    h("div", {}, submit)
  );

  const fields = { base_url: baseUrl, journeys: journeyBoxes[0]?.querySelector("input"), modes: modeBoxes[0]?.querySelector("input") };
  const markErrors = (problems) => {
    for (const [field, el] of Object.entries(errors)) el.textContent = problems.filter((p) => p.field === field).map((p) => p.message).join(" ");
    if (problems.some((p) => p.field === "base_url")) baseUrl.setAttribute("aria-invalid", "true");
    else baseUrl.removeAttribute("aria-invalid");
    if (problems.length) {
      showError(problems.length === 1 ? "There is a problem" : `There are ${problems.length} problems`, problems.map((p) => p.message));
      fields[problems.find((p) => fields[p.field])?.field]?.focus();
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.getAttribute("aria-disabled") === "true") return;
    clearError();
    const body = {
      base_url: baseUrl.value.trim(),
      journeys: [...form.querySelectorAll('input[name="journeys"]:checked')].map((el) => el.value),
      modes: [...form.querySelectorAll('input[name="modes"]:checked')].map((el) => el.value),
    };
    const problems = [];
    if (!/^https?:\/\/\S+$/i.test(body.base_url)) problems.push({ field: "base_url", message: "Enter the site's address, starting with https://." });
    if (!body.journeys.length) problems.push({ field: "journeys", message: "Choose at least one journey." });
    if (!body.modes.length) problems.push({ field: "modes", message: "Choose at least one mode." });
    markErrors(problems);
    if (problems.length) return;
    submit.setAttribute("aria-disabled", "true");
    announce("Starting the run…");
    try {
      const { run } = await api("/runs", { method: "POST", body });
      try {
        localStorage.setItem("srj:base_url", body.base_url);
      } catch {
        // Storage may be unavailable (private windows); remembering the address is only a convenience.
      }
      announce("Run queued.");
      location.hash = `#/runs/${run.id}`;
    } catch (error) {
      announce("");
      // A 401 has already signed the user out, which shows the sign-in page.
      if (error.errors?.length) markErrors(error.errors.map((e) => ({ field: e.field ?? "base_url", message: e.message })));
      else showError(error.message);
    } finally {
      submit.removeAttribute("aria-disabled");
    }
  });
  return form;
}

async function renderHome({ focus = true } = {}) {
  const formArea = h("div", {}, h("p", {}, "Loading the journeys…"));
  const runsArea = h("div", {}, h("p", {}, "Loading your runs…"));
  const refresh = h("button", { type: "button", class: "secondary" }, "Refresh the list");
  refresh.addEventListener("click", async () => {
    announce("Refreshing your runs…");
    await renderRunsTable(runsArea);
    announce("Your runs are up to date.");
  });
  show(
    "Runs",
    [
      h("h1", { tabindex: "-1" }, "Runs"),
      h("section", { "aria-labelledby": "new-run-heading" }, h("h2", { id: "new-run-heading" }, "Start a run"), formArea),
      h("section", { "aria-labelledby": "runs-heading" }, h("h2", { id: "runs-heading" }, "Your runs"), h("div", { class: "toolbar" }, refresh), runsArea),
    ],
    { focus }
  );
  const table = renderRunsTable(runsArea);
  try {
    formArea.replaceChildren(newRunForm(await loadCatalog()));
  } catch (error) {
    const retry = h("button", { type: "button", class: "secondary", onclick: () => renderHome() }, "Try again");
    formArea.replaceChildren(h("p", {}, "The journeys could not be loaded from the server."), retry);
    showError(error.message);
  }
  await table;
}

// One run ------------------------------------------------------------------------------------

let pollTimer;

async function signedLinks(paths) {
  if (!paths.length) return new Map();
  const { data, error } = await supabase.storage.from("reports").createSignedUrls(paths, LINK_SECONDS, { download: true });
  if (error) throw new Error(`The download links could not be made: ${error.message}`);
  return new Map(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

function runDetails(run, list, links) {
  const facts = [
    ["Status", badge(STATUS[run.status] ?? [run.status, "busy"])],
    ["Site", h("span", { class: "url" }, run.base_url)],
    ["Journeys", run.journeys.map((p) => journeyName(list, p)).join("; ")],
    ["Modes", run.modes.map((m) => MODES[m]?.[0] ?? m).join(", ")],
    ["Queued", when(run.created_at)],
    ["Started", when(run.started_at)],
    ["Finished", when(run.finished_at)],
  ];
  if (run.error) facts.push(["Problem", run.error]);
  const results = run.run_results ?? [];
  const files = run.summary?.files ?? [];
  const blocked = run.summary?.blocked_requests ?? [];
  return [
    h("h2", { id: "status-heading", tabindex: "-1" }, "Status"),
    h("dl", { class: "facts" }, facts.map(([term, value]) => [h("dt", {}, term), h("dd", {}, value)])),
    h("h2", { id: "results-heading" }, "Results"),
    results.length
      ? scrollable(h(
          "table",
          { "aria-labelledby": "results-heading" },
          h(
            "thead",
            {},
            h("tr", {}, ["Journey", "Mode", "Result", "Checks passed", "Findings", "Report"].map((c) => h("th", { scope: "col" }, c)))
          ),
          h(
            "tbody",
            {},
            results.map((r) => {
              const name = journeyName(list, r.journey);
              const mode = MODES[r.mode]?.[0] ?? r.mode;
              const link = r.report_path && links.get(r.report_path);
              return h(
                "tr",
                {},
                h("th", { scope: "row" }, name),
                h("td", {}, mode),
                h("td", {}, badge(RESULT[r.status] ?? [r.status, "bad"])),
                h("td", {}, `${r.checks_passed} of ${r.checks_total}`),
                h("td", {}, `${plural(r.errors, "error")}, ${plural(r.warnings, "warning")}`),
                h("td", {}, link ? h("a", { href: link }, "Download", hidden(` the report for ${name}, ${mode}`)) : "—")
              );
            })
          )
        ), "Results table")
      : h("p", {}, run.status === "done" || run.status === "failed" ? "This run has no results." : "Results appear here when the run finishes."),
    files.length ? [h("h2", {}, "Downloads"), h("p", {}, "Every file the run wrote. The links work for an hour; reload the page for new ones."), h("ul", { class: "files" }, files.map((path) => h("li", {}, links.get(path) ? h("a", { href: links.get(path) }, path.split("/").slice(1).join("/")) : path.split("/").slice(1).join("/"))))] : null,
    blocked.length
      ? [h("h2", {}, "Blocked requests"), h("p", {}, "The server's network guard stopped the page from reaching these addresses. A journey that needs one may have failed because of it."), h("ul", {}, blocked.map((b) => h("li", { class: "url" }, b)))]
      : null,
  ];
}

const finishedText = (run) => {
  if (run.status === "failed") return `The run failed: ${run.error ?? "no reason given"}`;
  const s = run.summary ?? {};
  return `The run finished: ${s.passed ?? 0} passed, ${s.failed ?? 0} failed, ${plural(s.errored ?? 0, "error")}.`;
};

async function renderRun(id, { focus = true } = {}) {
  const details = h("div", {}, h("p", {}, "Loading the run…"));
  const heading = h("h1", { tabindex: "-1" }, "Run");
  show("Run", [h("p", {}, h("a", { href: "#/" }, "Back to runs")), heading, details], { focus });
  const here = location.hash;
  let shown = null;

  async function refresh() {
    if (location.hash !== here) return;
    let run;
    try {
      ({ run } = await api(`/runs/${encodeURIComponent(id)}`));
    } catch (error) {
      if (shown) {
        // Keep what is on screen and try again: the server may be restarting.
        pollTimer = setTimeout(refresh, POLL_MS * 2);
        return;
      }
      details.replaceChildren(h("p", {}, error.status === 404 ? "There is no such run, or it is not yours." : "The run could not be loaded."));
      showError(error.message);
      return;
    }
    if (location.hash !== here) return;
    const key = `${run.status}|${run.run_results?.length ?? 0}`;
    if (key !== shown) {
      const list = await loadCatalog().catch(() => null);
      let links = new Map();
      try {
        links = await signedLinks([...new Set([...(run.summary?.files ?? []), ...(run.run_results ?? []).map((r) => r.report_path).filter(Boolean)])]);
      } catch (error) {
        showError(error.message);
      }
      const hadFocus = details.contains(document.activeElement);
      heading.textContent = `Run on ${hostOf(run.base_url)}`;
      document.title = `Run on ${hostOf(run.base_url)} – ${SITE}`;
      details.replaceChildren(...runDetails(run, list, links).flat(Infinity).filter(Boolean));
      if (hadFocus) $("status-heading")?.focus();
      if (shown !== null) announce(run.status === "done" || run.status === "failed" ? finishedText(run) : `The run is ${STATUS[run.status]?.[0].toLowerCase() ?? run.status}.`);
      shown = key;
    }
    if (run.status === "queued" || run.status === "running") pollTimer = setTimeout(refresh, POLL_MS);
  }
  await refresh();
}

// Routing and start-up -----------------------------------------------------------------------

let session = null;

function renderAccount() {
  account.replaceChildren();
  if (!session) return;
  const signOut = h("button", { type: "button", class: "secondary" }, "Sign out");
  signOut.addEventListener("click", async () => {
    await supabase.auth.signOut();
    announce("You are signed out.");
  });
  account.append(h("span", {}, "Signed in as ", h("strong", {}, session.user?.email ?? "you")), signOut);
}

/** Show the view for the current address. Hashes that are not routes (the skip link's #main) are left to the browser. */
function route({ focus = true } = {}) {
  if (location.hash && !location.hash.startsWith("#/")) return;
  clearTimeout(pollTimer);
  clearError();
  renderAccount();
  if (!session) return renderSignIn({ focus });
  const match = /^#\/runs\/([0-9a-f-]{36})$/i.exec(location.hash);
  return match ? renderRun(match[1], { focus }) : renderHome({ focus });
}

/** An error the auth server put in the address after a sign-in link (expired or used). */
function linkError() {
  const params = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
  const description = params.get("error_description") ?? fragment.get("error_description");
  if (params.has("error") || params.has("code") || fragment.has("error")) {
    history.replaceState(null, "", `${location.pathname}${fragment.has("error") ? "" : location.hash}`);
  }
  return description;
}

async function start() {
  if (!configured) {
    show("Setup needed", [h("h1", { tabindex: "-1" }, "Setup needed"), h("p", {}, "Set VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and VITE_API_URL, then build the dashboard again. docs/deploy.md explains where they come from.")], { focus: false });
    showError("This dashboard is not configured yet.");
    return;
  }
  ({
    data: { session },
  } = await supabase.auth.getSession());
  const problem = linkError();
  route({ focus: false });
  if (problem) showError(`The sign-in link did not work: ${problem}. Ask for a new one.`);
  window.addEventListener("hashchange", () => route());
  supabase.auth.onAuthStateChange((event, next) => {
    const changed = Boolean(next) !== Boolean(session);
    session = next;
    // Outside the callback: supabase-js holds a lock while it runs, and the views call back into it.
    setTimeout(() => (changed ? route() : renderAccount()), 0);
  });
}

start();
