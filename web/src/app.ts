/**
 * The dashboard: start runs through the API, follow a run, read its reports from run_reports,
 * and delete it. Sign-in and "Delete my account" are the platform's (src/lib/auth.ts,
 * mountSignIn, in the top bar).
 *
 * Accessibility: every view is plain HTML (headings, labelled fields, fieldsets, tables, links
 * and buttons); a page change moves focus to its heading; progress goes to the role="status"
 * line and errors to the role="alert" box, which stay in the page; status is always in words.
 *
 * Everything the page talks to comes in through `DashboardDeps`, so the tests run it under jsdom
 * with fakes and nothing reaches the network.
 */
import type { Session } from '@supabase/supabase-js';

export const SITE = 'Screen Reader Journeys';
export const POLL_MS = 4000;
export const BASE_URL_KEY = 'srj:base_url';

type Tone = 'busy' | 'ok' | 'bad';
const STATUS: Record<string, [string, Tone]> = {
  queued: ['Waiting', 'busy'],
  running: ['Running', 'busy'],
  done: ['Finished', 'ok'],
  failed: ['Failed', 'bad'],
};
const RESULT: Record<string, [string, Tone]> = { pass: ['Passed', 'ok'], fail: ['Failed', 'bad'], error: ['Error', 'bad'] };
export const MODES: Record<string, [string, string]> = {
  walker: ['Keyboard walker', "Each Tab stop's role, name and states, from Chromium's accessibility tree, and live-region announcements."],
  virtual: ['Emulated screen reader', "Guidepup's Virtual Screen Reader: its speech for each step, and line-by-line reading."],
};

export interface Journey {
  path: string;
  name: string;
  description?: string;
}
export interface Catalog {
  journeys: Journey[];
  modes: string[];
  allowed_hosts: string[];
}
export interface RunSummary {
  passed?: number;
  failed?: number;
  errored?: number;
  files?: string[];
  skipped_files?: string[];
  blocked_requests?: string[];
}
export interface RunResult {
  journey: string;
  mode: string;
  status: string;
  checks_passed: number;
  checks_total: number;
  errors: number;
  warnings: number;
  report_path: string | null;
}
export interface Run {
  id: string;
  base_url: string;
  journeys: string[];
  modes: string[];
  status: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  summary: RunSummary | null;
  run_results?: RunResult[];
}
interface ReportRow {
  path: string;
  content_type?: string;
  body?: string;
}

type DbResult<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;

/** The few supabase-js query shapes the dashboard uses (the real client satisfies it). */
export interface DashboardClient {
  from(table: 'runs'): {
    select(columns: string): { order(column: string, opts: { ascending: boolean }): { limit(n: number): DbResult<Run[]> } };
    delete(): { eq(column: string, value: string): DbResult<null> };
  };
  from(table: 'run_reports'): {
    select(columns: string): { eq(column: string, value: string): { in(column: string, values: string[]): DbResult<ReportRow[]> } };
  };
}

export interface DashboardDeps {
  doc: Document;
  win: Window & typeof globalThis;
  client: DashboardClient;
  apiUrl: string;
  fetch: typeof fetch;
  /** The signed-in person's access token, or null. */
  token: () => Promise<string | null>;
  /** Calls back with the session now and on every change (src/lib/auth.ts onAuth). */
  onAuth: (callback: (session: Session | null) => void) => void;
  /** Signs out of this app only, after the API says the session ended. */
  signOut: () => Promise<unknown>;
  /** Draws the platform's sign-in in the top bar. */
  mountSignIn: (el: HTMLElement) => void;
  pollMs?: number;
}

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, string | number | boolean | null | undefined | EventListener>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors: { field?: string; message: string }[] = [],
  ) {
    super(message);
  }
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fileName = (path: string) => path.split('/').pop() ?? path;

/** Start the dashboard in the page `deps.doc`. Resolves once the first view is drawn. */
export async function startDashboard(deps: DashboardDeps): Promise<void> {
  const { doc, win, client } = deps;
  const pollMs = deps.pollMs ?? POLL_MS;
  const byId = (id: string) => doc.getElementById(id);
  const need = (id: string) => {
    const el = byId(id);
    if (!el) throw new Error(`index.html needs #${id}`);
    return el;
  };
  const view = need('view');
  const account = need('account');
  const alertBox = need('alert');
  const statusLine = need('status');

  /** Build an element: h("a", { href: "#/" }, "text", child…). Text is always set as text, never as HTML. */
  function h(tag: string, props: Props = {}, ...children: Child[]): HTMLElement {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    const add = (child: Child) => {
      if (Array.isArray(child)) child.forEach(add);
      else if (child !== null && child !== undefined && child !== false) el.append(typeof child === 'object' ? child : String(child));
    };
    children.forEach(add);
    return el;
  }
  const hidden = (text: string) => h('span', { class: 'visually-hidden' }, text);
  const badge = ([label, tone]: [string, Tone]) => h('span', { class: `badge ${tone}` }, label);
  const when = (iso: string | null) =>
    iso ? h('time', { datetime: iso }, new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })) : '—';

  /**
   * Wrap a table so it scrolls sideways on narrow screens. Only while it overflows is the
   * wrapper a labelled region in the Tab order, so keyboard users can scroll it; otherwise it is
   * invisible to assistive technology and adds no Tab stop.
   */
  function scrollable(table: HTMLElement, label: string) {
    const wrap = h('div', { class: 'table-scroll' }, table);
    const update = () => {
      const overflows = wrap.scrollWidth > wrap.clientWidth + 1;
      for (const [name, value] of [['role', 'region'], ['tabindex', '0'], ['aria-label', label]]) {
        if (overflows) wrap.setAttribute(name, value);
        else wrap.removeAttribute(name);
      }
    };
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(update).observe(wrap);
    return wrap;
  }

  // Announcements ---------------------------------------------------------------------------

  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  /** Say something in the status line. Cleared first, so the same words are announced again. */
  function announce(text: string) {
    clearTimeout(statusTimer);
    statusLine.textContent = '';
    statusTimer = setTimeout(() => (statusLine.textContent = text), 50);
  }

  /** Show an error in the alert box: a sentence, or a heading and a list of problems. */
  function showError(message: string, problems: string[] = []) {
    alertBox.replaceChildren();
    if (problems.length) alertBox.append(h('h2', {}, message), h('ul', {}, problems.map((p) => h('li', {}, p))));
    else alertBox.append(h('p', {}, message));
  }
  const clearError = () => alertBox.replaceChildren();

  /** Replace the view, set the page title, and (after a person's action) move focus to the new heading. */
  function show(title: string, nodes: Node[], { focus = true } = {}) {
    view.replaceChildren(...nodes);
    doc.title = `${title} – ${SITE}`;
    if (focus) view.querySelector<HTMLElement>('h1')?.focus();
  }

  // The API ---------------------------------------------------------------------------------

  let session: Session | null = null;

  async function api<T>(path: string, { method = 'GET', body }: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await deps.token();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response: Response;
    try {
      response = await deps.fetch(`${deps.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'Could not reach the server. If it has been idle it may be starting up, which can take a minute; try again.');
    }
    const payload = (await response.json().catch(() => ({}))) as { error?: string; errors?: { field?: string; message: string }[] };
    if (response.status === 401 && token) {
      await deps.signOut();
      throw new ApiError(401, 'Your session has ended. Sign in again.');
    }
    if (!response.ok) throw new ApiError(response.status, payload.error ?? `The server answered ${response.status}.`, payload.errors ?? []);
    return payload as T;
  }

  let catalog: Promise<Catalog> | null = null;
  function loadCatalog(): Promise<Catalog> {
    catalog ??= api<Catalog>('/journeys').catch((error: unknown) => {
      catalog = null;
      throw error;
    });
    return catalog;
  }
  const journeyName = (list: Catalog | null, path: string) => list?.journeys.find((j) => j.path === path)?.name ?? path;

  // Signed out --------------------------------------------------------------------------------

  function renderSignedOut({ focus = true } = {}) {
    show(
      'Sign in',
      [
        h('h1', { tabindex: '-1' }, SITE),
        h(
          'p',
          {},
          'Walk a website the way a keyboard and screen reader user does, and read what they would hear: every Tab stop, every announcement, and the problems found on the way.',
        ),
        h('p', {}, 'Sign in at the top of the page, with Google or a code sent to your email, to start runs and read their reports.'),
      ],
      { focus },
    );
  }

  // Runs list and the new-run form ----------------------------------------------------------

  function runRow(run: Run) {
    const s = run.summary;
    const results = s
      ? [s.passed && `${s.passed} passed`, s.failed && `${s.failed} failed`, s.errored && plural(s.errored, 'error')].filter(Boolean).join(', ') || 'No results'
      : '—';
    return h(
      'tr',
      {},
      h('th', { scope: 'row' }, h('a', { href: `#/runs/${run.id}` }, when(run.created_at), hidden(`, ${hostOf(run.base_url)}`))),
      h('td', { class: 'url' }, hostOf(run.base_url)),
      h('td', {}, badge(STATUS[run.status] ?? [run.status, 'busy'])),
      h('td', {}, results),
    );
  }

  async function renderRunsTable(container: HTMLElement) {
    const { data, error } = await client.from('runs').select('id, base_url, status, created_at, summary').order('created_at', { ascending: false }).limit(50);
    if (error || !data) {
      container.replaceChildren(h('p', {}, 'Your runs could not be loaded.'));
      showError(`Your runs could not be loaded: ${error?.message ?? 'no answer'}`);
      return;
    }
    if (!data.length) {
      container.replaceChildren(h('p', {}, 'You have not started any runs yet.'));
      return;
    }
    const caption = `Your ${data.length === 50 ? '50 latest' : plural(data.length, 'run')}, newest first`;
    container.replaceChildren(
      scrollable(
        h(
          'table',
          {},
          h('caption', {}, caption),
          h(
            'thead',
            {},
            h('tr', {}, h('th', { scope: 'col' }, 'Started'), h('th', { scope: 'col' }, 'Site'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Results')),
          ),
          h('tbody', {}, data.map(runRow)),
        ),
        caption,
      ),
    );
  }

  function remembered(): string {
    try {
      return win.localStorage.getItem(BASE_URL_KEY) ?? '';
    } catch {
      return '';
    }
  }

  function newRunForm(list: Catalog) {
    const baseUrl = h('input', {
      id: 'base-url',
      name: 'base_url',
      type: 'url',
      inputmode: 'url',
      autocomplete: 'url',
      spellcheck: 'false',
      required: true,
      value: remembered(),
      'aria-describedby': 'base-url-hint base-url-error',
    }) as HTMLInputElement;
    const errors: Record<string, HTMLElement> = {
      base_url: h('p', { id: 'base-url-error', class: 'field-error' }),
      journeys: h('p', { id: 'journeys-error', class: 'field-error' }),
      modes: h('p', { id: 'modes-error', class: 'field-error' }),
    };
    const allowed = list.allowed_hosts.length
      ? `This server may test ${list.allowed_hosts.join(', ')}.`
      : 'This server has no allowed sites yet, so runs will be refused.';
    const journeyBoxes = list.journeys.map((journey, i) =>
      h(
        'div',
        { class: 'choice' },
        h('input', { type: 'checkbox', id: `journey-${i}`, name: 'journeys', value: journey.path, 'aria-describedby': journey.description ? `journey-${i}-hint` : null }),
        h('label', { for: `journey-${i}` }, journey.name),
        journey.description ? h('p', { id: `journey-${i}-hint`, class: 'hint' }, journey.description) : null,
      ),
    );
    const modeBoxes = list.modes.map((mode) =>
      h(
        'div',
        { class: 'choice' },
        h('input', { type: 'checkbox', id: `mode-${mode}`, name: 'modes', value: mode, checked: true, 'aria-describedby': `mode-${mode}-hint` }),
        h('label', { for: `mode-${mode}` }, MODES[mode]?.[0] ?? mode),
        h('p', { id: `mode-${mode}-hint`, class: 'hint' }, MODES[mode]?.[1] ?? ''),
      ),
    );
    const submit = h('button', { type: 'submit', 'aria-describedby': 'start-hint' }, 'Start run');
    const form = h(
      'form',
      { novalidate: true, 'aria-labelledby': 'new-run-heading' },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'base-url' }, 'Site address'),
        h('p', { id: 'base-url-hint', class: 'hint' }, `Where the journeys start, for example a pull request's preview. ${allowed}`),
        baseUrl,
        errors.base_url,
      ),
      h('fieldset', { 'aria-describedby': 'journeys-error' }, h('legend', {}, 'Journeys'), journeyBoxes, errors.journeys),
      h('fieldset', { 'aria-describedby': 'modes-error' }, h('legend', {}, 'Modes'), modeBoxes, errors.modes),
      h(
        'div',
        {},
        h('p', { id: 'start-hint', class: 'hint' }, 'After a quiet spell the server is asleep, and the first run waits about a minute while it wakes.'),
        submit,
      ),
    ) as HTMLFormElement;

    const fields: Record<string, HTMLElement | null | undefined> = {
      base_url: baseUrl,
      journeys: journeyBoxes[0]?.querySelector('input'),
      modes: modeBoxes[0]?.querySelector('input'),
    };
    const markErrors = (problems: { field: string; message: string }[]) => {
      for (const [field, el] of Object.entries(errors)) el.textContent = problems.filter((p) => p.field === field).map((p) => p.message).join(' ');
      if (problems.some((p) => p.field === 'base_url')) baseUrl.setAttribute('aria-invalid', 'true');
      else baseUrl.removeAttribute('aria-invalid');
      if (problems.length) {
        showError(problems.length === 1 ? 'There is a problem' : `There are ${problems.length} problems`, problems.map((p) => p.message));
        const first = problems.find((p) => fields[p.field]);
        if (first) fields[first.field]?.focus();
      }
    };
    const checked = (name: string) => [...form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((el) => el.value);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.getAttribute('aria-disabled') === 'true') return;
      clearError();
      const body = { base_url: baseUrl.value.trim(), journeys: checked('journeys'), modes: checked('modes') };
      const problems: { field: string; message: string }[] = [];
      if (!/^https?:\/\/\S+$/i.test(body.base_url)) problems.push({ field: 'base_url', message: "Enter the site's address, starting with https://." });
      if (!body.journeys.length) problems.push({ field: 'journeys', message: 'Choose at least one journey.' });
      if (!body.modes.length) problems.push({ field: 'modes', message: 'Choose at least one mode.' });
      markErrors(problems);
      if (problems.length) return;
      submit.setAttribute('aria-disabled', 'true');
      announce('Starting the run…');
      try {
        const { run } = await api<{ run: { id: string } }>('/runs', { method: 'POST', body });
        try {
          win.localStorage.setItem(BASE_URL_KEY, body.base_url);
        } catch {
          // Storage may be unavailable (private windows); remembering the address is only a convenience.
        }
        announce('Run queued.');
        win.location.hash = `#/runs/${run.id}`;
      } catch (error) {
        announce('');
        // A 401 has already signed the person out, which shows the signed-out page.
        const e = error as ApiError;
        if (e.errors?.length) markErrors(e.errors.map((x) => ({ field: x.field ?? 'base_url', message: x.message })));
        else showError(e.message);
      } finally {
        submit.removeAttribute('aria-disabled');
      }
    });
    return form;
  }

  async function renderHome({ focus = true } = {}) {
    const formArea = h('div', {}, h('p', {}, 'Loading the journeys…'));
    const runsArea = h('div', {}, h('p', {}, 'Loading your runs…'));
    const refresh = h('button', { type: 'button', class: 'secondary' }, 'Refresh the list');
    refresh.addEventListener('click', async () => {
      announce('Refreshing your runs…');
      await renderRunsTable(runsArea);
      announce('The list is up to date.');
    });
    show(
      'Runs',
      [
        h('h1', { tabindex: '-1' }, 'Runs'),
        h('section', { 'aria-labelledby': 'new-run-heading' }, h('h2', { id: 'new-run-heading' }, 'Start a run'), formArea),
        h('section', { 'aria-labelledby': 'runs-heading' }, h('h2', { id: 'runs-heading' }, 'Your runs'), h('div', { class: 'toolbar' }, refresh), runsArea),
      ],
      { focus },
    );
    const table = renderRunsTable(runsArea);
    try {
      formArea.replaceChildren(newRunForm(await loadCatalog()));
    } catch (error) {
      const retry = h('button', { type: 'button', class: 'secondary', onclick: () => void renderHome() }, 'Try again');
      formArea.replaceChildren(h('p', {}, 'The journeys could not be loaded from the server.'), retry);
      showError((error as Error).message);
    }
    await table;
  }

  // One run -----------------------------------------------------------------------------------

  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Which of a run's report files are there (row level security: your own runs only). Only the
   * names: each body is fetched when its download is asked for.
   */
  async function reportFiles(runId: string, paths: string[]): Promise<Set<string>> {
    if (!paths.length) return new Set();
    const { data, error } = await client.from('run_reports').select('path, content_type').eq('run_id', runId).in('path', paths);
    if (error || !data) throw new Error(`The reports could not be loaded: ${error?.message ?? 'no answer'}`);
    return new Set(data.map((d) => d.path));
  }

  /**
   * Fetch one report and save it. Always application/octet-stream: a report is a download, never
   * a page opened at this site's address, next to the person's session.
   */
  async function downloadReport(runId: string, path: string) {
    announce(`Downloading ${fileName(path)}…`);
    const { data, error } = await client.from('run_reports').select('path, body').eq('run_id', runId).in('path', [path]);
    const row = data?.[0];
    if (error || !row || typeof row.body !== 'string') {
      announce('');
      showError(`The report could not be downloaded: ${error?.message ?? 'it is no longer there'}`);
      return;
    }
    const url = URL.createObjectURL(new Blob([row.body], { type: 'application/octet-stream' }));
    const a = h('a', { href: url, download: fileName(path), hidden: true });
    doc.body.append(a);
    a.click();
    a.remove();
    // After the download has started.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    announce(`Downloaded ${fileName(path)}.`);
  }

  function deleteButton(run: Run) {
    const button = h('button', { type: 'button', class: 'secondary danger' }, 'Delete this run');
    button.addEventListener('click', async () => {
      if (!win.confirm(`Delete this run on ${hostOf(run.base_url)}, with its results and reports? This cannot be undone.`)) return;
      clearTimeout(pollTimer);
      const { error } = await client.from('runs').delete().eq('id', run.id);
      if (error) {
        showError(`The run could not be deleted: ${error.message}`);
        return;
      }
      announce('The run is deleted.');
      win.location.hash = '#/';
    });
    return button;
  }

  function runDetails(run: Run, list: Catalog | null, available: Set<string>): Child[] {
    const facts: [string, Child][] = [
      ['Status', badge(STATUS[run.status] ?? [run.status, 'busy'])],
      ['Site', h('span', { class: 'url' }, run.base_url)],
      ['Journeys', run.journeys.map((p) => journeyName(list, p)).join('; ')],
      ['Modes', run.modes.map((m) => MODES[m]?.[0] ?? m).join(', ')],
      ['Queued', when(run.created_at)],
      ['Started', when(run.started_at)],
      ['Finished', when(run.finished_at)],
    ];
    if (run.error) facts.push(['Problem', run.error]);
    const results = run.run_results ?? [];
    const files = run.summary?.files ?? [];
    const skipped = run.summary?.skipped_files ?? [];
    const blocked = run.summary?.blocked_requests ?? [];
    const download = (path: string, text: Child) =>
      available.has(path) ? h('button', { type: 'button', class: 'link-button', onclick: () => void downloadReport(run.id, path) }, text) : null;
    const waiting = run.status === 'queued' || run.status === 'running';
    return [
      h('h2', { id: 'status-heading', tabindex: '-1' }, 'Status'),
      h('dl', { class: 'facts' }, facts.map(([term, value]) => [h('dt', {}, term), h('dd', {}, value)])),
      waiting
        ? h(
            'p',
            { class: 'hint', id: 'sleep-note' },
            'The server sleeps after 15 minutes without visitors, and takes about a minute to wake, so a run may wait before it starts. Keep this page open until the run finishes: if the server goes to sleep while nobody has the page open, the run stops and goes back in the queue, and starts again when someone next visits.',
          )
        : null,
      h('h2', { id: 'results-heading' }, 'Results'),
      results.length
        ? scrollable(
            h(
              'table',
              { 'aria-labelledby': 'results-heading' },
              h('thead', {}, h('tr', {}, ['Journey', 'Mode', 'Result', 'Checks passed', 'Findings', 'Report'].map((c) => h('th', { scope: 'col' }, c)))),
              h(
                'tbody',
                {},
                results.map((r) => {
                  const name = journeyName(list, r.journey);
                  const mode = MODES[r.mode]?.[0] ?? r.mode;
                  return h(
                    'tr',
                    {},
                    h('th', { scope: 'row' }, name),
                    h('td', {}, mode),
                    h('td', {}, badge(RESULT[r.status] ?? [r.status, 'bad'])),
                    h('td', {}, `${r.checks_passed} of ${r.checks_total}`),
                    h('td', {}, `${plural(r.errors, 'error')}, ${plural(r.warnings, 'warning')}`),
                    h('td', {}, (r.report_path && download(r.report_path, ['Download', hidden(` the report for ${name}, ${mode}`)])) || '—'),
                  );
                }),
              ),
            ),
            'Results table',
          )
        : h('p', {}, run.status === 'done' || run.status === 'failed' ? 'This run has no results.' : 'Results appear here when the run finishes.'),
      files.length
        ? [h('h2', {}, 'Downloads'), h('p', {}, 'Every file the run wrote.'), h('ul', { class: 'files' }, files.map((path) => h('li', {}, download(path, path) ?? path)))]
        : null,
      skipped.length
        ? [h('h2', {}, 'Files left out'), h('p', {}, 'These files were too large to keep (over 2 MB).'), h('ul', {}, skipped.map((path) => h('li', {}, path)))]
        : null,
      blocked.length
        ? [
            h('h2', {}, 'Blocked requests'),
            h('p', {}, "The server's network guard stopped the page from reaching these addresses. A journey that needs one may have failed because of it."),
            h('ul', {}, blocked.map((b) => h('li', { class: 'url' }, b))),
          ]
        : null,
      waiting ? null : [h('h2', {}, 'Delete'), h('p', {}, deleteButton(run))],
    ];
  }

  const finishedText = (run: Run) => {
    if (run.status === 'failed') return `The run failed: ${run.error ?? 'no reason given'}`;
    const s = run.summary ?? {};
    return `The run finished: ${s.passed ?? 0} passed, ${s.failed ?? 0} failed, ${plural(s.errored ?? 0, 'error')}.`;
  };

  async function renderRun(id: string, { focus = true } = {}) {
    const details = h('div', {}, h('p', {}, 'Loading the run…'));
    const heading = h('h1', { tabindex: '-1' }, 'Run');
    show('Run', [h('p', {}, h('a', { href: '#/' }, 'Back to runs')), heading, details], { focus });
    const here = win.location.hash;
    let shown: string | null = null;

    async function refresh() {
      if (win.location.hash !== here) return;
      let run: Run;
      try {
        ({ run } = await api<{ run: Run }>(`/runs/${encodeURIComponent(id)}`));
      } catch (error) {
        if (shown) {
          // Keep what is on screen and try again: the server may be restarting.
          pollTimer = setTimeout(refresh, pollMs * 2);
          return;
        }
        details.replaceChildren(h('p', {}, (error as ApiError).status === 404 ? 'There is no such run, or it is not yours.' : 'The run could not be loaded.'));
        showError((error as Error).message);
        return;
      }
      if (win.location.hash !== here) return;
      const key = `${run.status}|${run.run_results?.length ?? 0}`;
      if (key !== shown) {
        const list = await loadCatalog().catch(() => null);
        let available = new Set<string>();
        try {
          available = await reportFiles(run.id, [...new Set([...(run.summary?.files ?? []), ...(run.run_results ?? []).map((r) => r.report_path).filter((p): p is string => Boolean(p))])]);
        } catch (error) {
          showError((error as Error).message);
        }
        const hadFocus = details.contains(doc.activeElement);
        heading.textContent = `Run on ${hostOf(run.base_url)}`;
        doc.title = `Run on ${hostOf(run.base_url)} – ${SITE}`;
        const nodes: Node[] = [];
        const collect = (child: Child) => {
          if (Array.isArray(child)) child.forEach(collect);
          else if (child instanceof win.Node) nodes.push(child);
        };
        collect(runDetails(run, list, available));
        details.replaceChildren(...nodes);
        if (hadFocus) byId('status-heading')?.focus();
        if (shown !== null) announce(run.status === 'done' || run.status === 'failed' ? finishedText(run) : `The run is ${STATUS[run.status]?.[0].toLowerCase() ?? run.status}.`);
        shown = key;
      }
      if (run.status === 'queued' || run.status === 'running') pollTimer = setTimeout(refresh, pollMs);
    }
    await refresh();
  }

  // Routing and start-up ------------------------------------------------------------------------

  /** Show the view for the current address. Hashes that are not routes (the skip link's #main) are left to the browser. */
  function route({ focus = true } = {}): Promise<void> | void {
    const hash = win.location.hash;
    if (hash && !hash.startsWith('#/')) return;
    clearTimeout(pollTimer);
    clearError();
    if (!session) return renderSignedOut({ focus });
    const match = /^#\/runs\/([0-9a-f-]{36})$/i.exec(hash);
    return match ? renderRun(match[1], { focus }) : renderHome({ focus });
  }

  deps.mountSignIn(account);
  let first = true;
  await new Promise<void>((resolve) => {
    deps.onAuth((next) => {
      const changed = Boolean(next) !== Boolean(session);
      session = next;
      if (first) {
        first = false;
        void Promise.resolve(route({ focus: false })).then(resolve);
        return;
      }
      // Outside the callback: supabase-js holds a lock while it runs, and the views call back into it.
      if (changed) setTimeout(() => void route(), 0);
    });
  });
  win.addEventListener('hashchange', () => void route());
}
